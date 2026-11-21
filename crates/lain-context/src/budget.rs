use std::{cmp::Reverse, fmt};

use tiktoken_rs::{bpe_for_model, cl100k_base_singleton, CoreBPE};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ContextPriority {
    Required,
    ActiveToolExchange,
    Conversation,
    RepoMap,
    RecalledContext,
    OldToolOutput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("required prompt context does not fit in a {limit}-token window")]
pub struct ContextOverflow {
    pub limit: usize,
}

pub struct ContextBudgeter {
    limit: usize,
    tokenizer: &'static CoreBPE,
}

impl fmt::Debug for ContextBudgeter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ContextBudgeter")
            .field("limit", &self.limit)
            .finish_non_exhaustive()
    }
}

impl ContextBudgeter {
    /// Unknown model names use cl100k as an estimate; their provider can tokenize differently.
    pub fn new(model: &str, limit: usize) -> Self {
        let tokenizer = bpe_for_model(model).unwrap_or_else(|_| cl100k_base_singleton());
        Self { limit, tokenizer }
    }

    pub fn count(&self, text: &str) -> usize {
        self.tokenizer.encode_ordinary(text).len()
    }

    /// Selects newer entries first within each priority, then returns them in original order.
    /// The callback may return a cheaper representation, or decline the entry if it cannot fit.
    pub fn select<T>(
        &self,
        reserved: usize,
        priorities: &[ContextPriority],
        mut fit: impl FnMut(usize, usize) -> Option<(usize, T)>,
    ) -> Result<Vec<Option<T>>, ContextOverflow> {
        let overflow = ContextOverflow { limit: self.limit };
        let mut remaining = self.limit.checked_sub(reserved).ok_or(overflow)?;
        let mut ranked: Vec<_> = priorities.iter().copied().enumerate().collect();
        ranked.sort_unstable_by_key(|&(index, priority)| (priority, Reverse(index)));
        let mut selected: Vec<_> = priorities.iter().map(|_| None).collect();
        for (index, priority) in ranked {
            match fit(index, remaining).filter(|(cost, _)| *cost <= remaining) {
                Some((cost, value)) => {
                    remaining -= cost;
                    if let Some(slot) = selected.get_mut(index) {
                        *slot = Some(value);
                    }
                }
                None if matches!(
                    priority,
                    ContextPriority::Required | ContextPriority::ActiveToolExchange
                ) =>
                {
                    return Err(overflow)
                }
                None => {}
            }
        }
        Ok(selected)
    }
}

#[cfg(test)]
mod tests {
    use super::{ContextPriority::*, *};

    #[test]
    fn protects_required_context_then_picks_recent_conversation_before_map_and_tools() {
        let budget = ContextBudgeter::new("local-model", 16);
        let groups = [
            Required,
            Required,
            Conversation,
            OldToolOutput,
            RepoMap,
            Conversation,
        ];
        let costs = [3, 2, 6, 1, 3, 4];
        let selected = budget
            .select(4, &groups, |i, _| costs.get(i).map(|cost| (*cost, i)))
            .unwrap();
        assert_eq!(selected, [Some(0), Some(1), None, None, Some(4), Some(5)]);
    }

    #[test]
    fn allows_a_cheaper_variant_but_never_discards_required_entries() {
        let budget = ContextBudgeter::new("gpt-4o", 12);
        let selected = budget.select(3, &[Required, OldToolOutput], |index, left| {
            if index == 0 {
                Some((7, "rules"))
            } else if left >= 4 {
                Some((4, "full output"))
            } else {
                Some((2, "clipped"))
            }
        });
        assert_eq!(selected, Ok(vec![Some("rules"), Some("clipped")]));
        assert_eq!(
            budget.select(6, &[Required], |_, _| Some((7, "system"))),
            Err(ContextOverflow { limit: 12 }),
        );
        assert!(budget.count("🍵 <|endoftext|> 树") > 3);
    }
}
