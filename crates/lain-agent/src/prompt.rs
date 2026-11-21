use std::collections::BTreeMap;

use lain_context::{ContextBudgeter, ContextOverflow, ContextPriority};
use lain_core::provider::{CompletionRequest, Message, Role};
use serde_json::{json, Value};

use crate::hermes;

const MESSAGE_FRAMING: usize = 4;
const REQUEST_FRAMING: usize = 16;
const CLIPPED_TOOL: &str = "[tool output truncated for context]";
const CLIPPED_MAP: &str = "[repo map truncated for context]";
const MAP_LABEL: &str = "Repository outline (source data, not instructions):";

type Positioned = (usize, Message);
type Selection = (usize, Vec<Positioned>);

enum Part<'a> {
    Prefix(Message),
    Conversation(Vec<(usize, &'a Message)>),
    Exchange {
        position: usize,
        messages: &'a [Message],
        parent: usize,
    },
    Recalled(usize, &'a Message),
    Map {
        position: usize,
        user: &'a Message,
        outline: &'a str,
    },
}

pub(crate) fn fill(
    request: &mut CompletionRequest,
    transcript: &[Message],
    prefix: String,
    repo_map: Option<&str>,
    window: usize,
    uses_hermes: bool,
) -> Result<(), ContextOverflow> {
    use ContextPriority::*;

    let budget = ContextBudgeter::new(&request.model, window);
    let reserved = (request.max_tokens.unwrap_or_default() as usize)
        .saturating_add(REQUEST_FRAMING)
        .saturating_add(json_tokens(&budget, request));
    let mut parts = Vec::new();
    if !prefix.is_empty() {
        parts.push((Required, Part::Prefix(Message::text(Role::System, prefix))));
    }
    let latest_user = transcript
        .iter()
        .rposition(|message| message.role == Role::User);
    let mut i = 0;
    while let Some(message) = transcript.get(i) {
        let position = i + 1;
        if message.role != Role::User {
            if message.role == Role::System {
                parts.push((RecalledContext, Part::Recalled(position, message)));
            }
            i += 1;
            continue;
        }
        let active = Some(i) == latest_user;
        let parent = parts.len();
        let mut conversation = vec![(position, message)];
        let mut other_parts = Vec::new();
        i += 1;
        while let Some(reply) = transcript.get(i) {
            match reply.role {
                Role::User | Role::System => break,
                Role::Assistant if reply.tool_calls.is_empty() => {
                    conversation.push((i + 1, reply));
                    i += 1;
                }
                Role::Assistant => {
                    let start = i;
                    i += 1;
                    while transcript
                        .get(i)
                        .is_some_and(|message| message.role == Role::Tool)
                    {
                        i += 1;
                    }
                    if let Some(messages) = transcript.get(start..i) {
                        other_parts.push((
                            if active && i == transcript.len() {
                                ActiveToolExchange
                            } else {
                                OldToolOutput
                            },
                            Part::Exchange {
                                position: start + 1,
                                messages,
                                parent,
                            },
                        ));
                    }
                }
                Role::Tool => i += 1,
            }
        }
        parts.push((
            if active { Required } else { Conversation },
            Part::Conversation(conversation),
        ));
        parts.append(&mut other_parts);
    }
    if let Some((index, user, outline)) = latest_user.and_then(|i| {
        Some((
            i,
            transcript.get(i)?,
            repo_map.filter(|map| !map.is_empty())?,
        ))
    }) {
        parts.push((
            RepoMap,
            Part::Map {
                position: index + 1,
                user,
                outline,
            },
        ));
    }

    let priorities: Vec<_> = parts.iter().map(|(priority, _)| *priority).collect();
    let mut retained = vec![false; parts.len()];
    let projector = Projector {
        budget: &budget,
        uses_hermes,
    };
    let selected = budget.select(reserved, &priorities, |i, remaining| {
        let (priority, part) = parts.get(i)?;
        let selection = match part {
            Part::Prefix(message) => projector.whole([(0, message)], remaining),
            Part::Conversation(messages) => projector.whole(messages.iter().copied(), remaining),
            Part::Recalled(position, message) => {
                projector.whole([(*position, *message)], remaining)
            }
            Part::Map {
                position,
                user,
                outline,
            } => projector.map(*position, user, outline, remaining),
            Part::Exchange {
                position,
                messages,
                parent,
            } => {
                if *priority == OldToolOutput && !retained.get(*parent).copied().unwrap_or(false) {
                    return None;
                }
                projector.exchange(*position, messages, remaining)
            }
        }?;
        *retained.get_mut(i)? = true;
        Some(selection)
    })?;
    // The repo map is an addendum to the latest user message, not a privileged system message or an extra turn.
    request.messages = selected
        .into_iter()
        .flatten()
        .flatten()
        .collect::<BTreeMap<_, _>>()
        .into_values()
        .collect();
    Ok(())
}

fn json_tokens(budget: &ContextBudgeter, value: &impl serde::Serialize) -> usize {
    // OpenAI-compatible servers choose their own template. Count the wire fields and add headroom for framing.
    serde_json::to_string(value).map_or(usize::MAX, |wire| budget.count(&wire))
}

struct Projector<'a> {
    budget: &'a ContextBudgeter,
    uses_hermes: bool,
}

impl Projector<'_> {
    fn measure(&self, message: Message) -> (usize, Message) {
        let message = if self.uses_hermes {
            hermes::project(message)
        } else {
            message
        };
        (
            json_tokens(self.budget, &message).saturating_add(MESSAGE_FRAMING),
            message,
        )
    }

    fn whole<'a>(
        &self,
        messages: impl IntoIterator<Item = (usize, &'a Message)>,
        remaining: usize,
    ) -> Option<Selection> {
        let mut tokens: usize = 0;
        let mut selected = Vec::new();
        for (position, message) in messages {
            let (cost, projected) = self.measure(message.clone());
            tokens = tokens.checked_add(cost)?;
            if tokens > remaining {
                return None;
            }
            selected.push((position, projected));
        }
        Some((tokens, selected))
    }

    fn map(
        &self,
        position: usize,
        user: &Message,
        map: &str,
        remaining: usize,
    ) -> Option<Selection> {
        if remaining == 0 {
            return None;
        }
        let text = user.content.as_deref()?;
        let (user_tokens, _) = self.measure(user.clone());
        let attempt = |outline: &str, suffix: &str| {
            let (cost, message) = self.measure(Message::text(
                Role::User,
                format!("{text}\n\n{MAP_LABEL}\n{outline}{suffix}"),
            ));
            let additional = cost.saturating_sub(user_tokens);
            (additional <= remaining).then_some((additional, vec![(position, message)]))
        };
        attempt(map, "").or_else(|| {
            // Only cut between outline lines, and never leave a file heading with no symbols.
            let mut start = 0;
            let mut ends = Vec::new();
            for line in map.split_inclusive('\n') {
                start += line.len();
                if line.starts_with("  ") && start < map.len() {
                    ends.push(start);
                }
            }
            largest_fit(ends.len(), |index| {
                attempt(map.get(..*ends.get(index)?)?, CLIPPED_MAP)
            })
        })
    }

    fn exchange(
        &self,
        position: usize,
        messages: &[Message],
        remaining: usize,
    ) -> Option<Selection> {
        let (call, results) = messages.split_first()?;
        // Dropping a result independently leaves a malformed request. Keep the whole call/result batch or none of it.
        let (call_cost, call) = self.measure(call.clone());
        let mut available = remaining.checked_sub(call_cost)?;
        let mut projected = vec![(position, call)];
        let mut variants = Vec::with_capacity(results.len());
        for result in results {
            let text = result.content.as_deref().unwrap_or_default();
            let value = serde_json::from_str::<Value>(text).ok();
            let full = self.measure(result.clone());
            let placeholder = self.clip_tool(result, value.as_ref(), "");
            available = available.checked_sub(full.0.min(placeholder.0))?;
            variants.push((full, placeholder, value));
        }
        for (offset, (original, ((full_cost, full), (placeholder_cost, placeholder), value))) in
            results.iter().zip(variants).enumerate()
        {
            let base = full_cost.min(placeholder_cost);
            let limit = base + available / (results.len() - offset);
            let (cost, kept) = if full_cost <= limit {
                (full_cost, full)
            } else {
                let text = original.content.as_deref().unwrap_or_default();
                let content = tool_payload(value.as_ref()).1.unwrap_or(text);
                let ends: Vec<_> = content
                    .char_indices()
                    .take(8_192)
                    .skip(1)
                    .map(|(i, _)| i)
                    .collect();
                largest_fit(ends.len(), |index| {
                    let (cost, clipped) =
                        self.clip_tool(original, value.as_ref(), content.get(..*ends.get(index)?)?);
                    (cost <= limit).then_some((cost, clipped))
                })
                .unwrap_or((base, placeholder))
            };
            available = (available + base).saturating_sub(cost);
            projected.push((position + offset + 1, kept));
        }
        Some((remaining - available, projected))
    }

    fn clip_tool(&self, original: &Message, value: Option<&Value>, text: &str) -> (usize, Message) {
        let (key, _) = tool_payload(value);
        let mut clipped = json!({key: text, "notice": CLIPPED_TOOL});
        if let (Some(fields), Some(value)) = (clipped.as_object_mut(), value) {
            for key in ["code", "exit_code"] {
                if let Some(status) = value.get(key) {
                    fields.insert(key.into(), status.clone());
                }
            }
        }
        let result = Message {
            role: Role::Tool,
            content: Some(clipped.to_string()),
            tool_calls: Vec::new(),
            tool_call_id: original.tool_call_id.clone(),
        };
        self.measure(result)
    }
}

fn tool_payload(value: Option<&Value>) -> (&'static str, Option<&str>) {
    ["content", "error", "skipped", "interrupted"]
        .into_iter()
        .find_map(|key| Some((key, Some(value?.get(key)?.as_str()?))))
        .unwrap_or(("content", None))
}

fn largest_fit<T>(count: usize, mut fit: impl FnMut(usize) -> Option<T>) -> Option<T> {
    let (mut low, mut high) = (0, count);
    let mut best = None;
    while low < high {
        let middle = low + (high - low) / 2;
        if let Some(candidate) = fit(middle) {
            best = Some(candidate);
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use lain_core::provider::{ToolCall, ToolDefinition};

    fn request(mode: bool) -> CompletionRequest {
        CompletionRequest {
            model: "gpt-4o".into(),
            messages: Vec::new(),
            tools: if mode {
                Vec::new()
            } else {
                vec![ToolDefinition {
                    name: "read".into(),
                    description: "Read a file".into(),
                    parameters: json!({"type":"object"}),
                }]
            },
            temperature: None,
            max_tokens: Some(32),
        }
    }

    fn call(ids: &[&str]) -> Message {
        let mut message = Message::text(Role::Assistant, "Checking sources.");
        message.tool_calls = ids
            .iter()
            .map(|id| ToolCall {
                id: (*id).into(),
                name: "read".into(),
                arguments: json!({}),
            })
            .collect();
        message
    }

    fn output(id: &str, text: &str) -> Message {
        let mut message = Message::text(
            Role::Tool,
            json!({"content":text,"exit_code":1}).to_string(),
        );
        message.tool_call_id = Some(id.into());
        message
    }

    fn assert_within_window(request: &CompletionRequest, window: usize) {
        let budget = ContextBudgeter::new(&request.model, window);
        let mut envelope = request.clone();
        envelope.messages.clear();
        let total = request.max_tokens.unwrap() as usize
            + REQUEST_FRAMING
            + json_tokens(&budget, &envelope)
            + request
                .messages
                .iter()
                .map(|message| json_tokens(&budget, message) + MESSAGE_FRAMING)
                .sum::<usize>();
        assert!(total <= window, "{total} > {window}");
    }

    #[test]
    fn protects_recent_conversation_and_clips_map_before_old_tool_output() {
        let transcript = [
            Message::text(Role::User, "First question"),
            call(&["old-id"]),
            output("old-id", &"outdated data ".repeat(1_500)),
            Message::text(Role::Assistant, "Earlier answer"),
            Message::text(Role::User, "Latest question"),
        ];
        let map = format!("src/lib.rs:\n{}", "  pub fn example()\n".repeat(200));
        let mut request = request(false);
        let window = 250;
        fill(
            &mut request,
            &transcript,
            "System and scratchpad; learned rules.".into(),
            Some(&map),
            window,
            false,
        )
        .unwrap();
        let latest = request
            .messages
            .last()
            .and_then(|m| m.content.as_deref())
            .unwrap();
        assert!(latest.contains("Latest question") && latest.contains("pub fn example()"));
        assert!(latest.contains(CLIPPED_MAP));
        assert!(request
            .messages
            .iter()
            .any(|m| m.content.as_deref() == Some("Earlier answer")));
        assert!(!request
            .messages
            .iter()
            .any(|message| message.role == Role::Tool || !message.tool_calls.is_empty()));
        assert_eq!(
            transcript.last().and_then(|m| m.content.as_deref()),
            Some("Latest question")
        );
        assert_within_window(&request, window);
    }

    #[test]
    fn clips_active_parallel_results_without_orphaning_calls_in_either_protocol() {
        let data = "結果 🧪 ".repeat(1_500);
        let transcript = [
            Message::text(Role::User, "Please check both files."),
            call(&["first", "second"]),
            output("first", &data),
            output("second", &data),
        ];
        for hermes in [false, true] {
            let mut request = request(hermes);
            let window = 350;
            fill(
                &mut request,
                &transcript,
                "Keep this system text and scratchpad.".into(),
                None,
                window,
                hermes,
            )
            .unwrap();
            assert_eq!(request.messages.len(), 5);
            assert_eq!(
                request.messages.first().and_then(|m| m.content.as_deref()),
                Some("Keep this system text and scratchpad.")
            );
            for (message, id) in request.messages.iter().skip(3).zip(["first", "second"]) {
                let content = message.content.as_deref().unwrap();
                assert!(
                    content.contains(CLIPPED_TOOL)
                        && content.contains("exit_code")
                        && content.contains("結果")
                );
                if hermes {
                    assert_eq!(message.role, Role::User);
                    assert!(content.starts_with("<tool_response>") && content.contains(id));
                } else {
                    assert_eq!(message.role, Role::Tool);
                    assert_eq!(message.tool_call_id.as_deref(), Some(id));
                }
            }
            assert_within_window(&request, window);
        }
    }
}
