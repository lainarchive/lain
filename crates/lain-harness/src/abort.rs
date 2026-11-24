use futures::StreamExt;
use lain_core::{
    provider::{CompletionRequest, Message, ModelProvider, Role, Token},
    CoreError,
};
use regex::Regex;

#[derive(Debug, Clone)]
pub struct Rule {
    pub name: String,
    pub pattern: Regex,
    pub correction: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Continue,
    Abort {
        rule: String,
        correction: String,
        keep: String,
    },
}

#[derive(Debug, Clone)]
pub struct StreamWatcher {
    rules: Vec<Rule>,
    buffer: String,
}

impl StreamWatcher {
    pub fn new(rules: Vec<Rule>) -> Self {
        Self {
            rules,
            buffer: String::new(),
        }
    }
    pub fn reset(&mut self) {
        self.buffer.clear();
    }
    pub fn text(&self) -> &str {
        &self.buffer
    }

    pub fn push(&mut self, token: &str) -> Verdict {
        self.buffer.push_str(token);
        let earliest = self
            .rules
            .iter()
            .filter_map(|rule| {
                rule.pattern
                    .find(&self.buffer)
                    .map(|found| (found.start(), rule))
            })
            .min_by_key(|(start, _)| *start);
        match earliest {
            Some((start, rule)) => Verdict::Abort {
                rule: rule.name.clone(),
                correction: rule.correction.clone(),
                keep: self.buffer.get(..start).unwrap_or_default().into(),
            },
            None => Verdict::Continue,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TurnError {
    #[error(transparent)]
    Provider(#[from] CoreError),
    #[error("stream abort restart budget exhausted by rule {0}")]
    Exhausted(String),
    #[error("text-only turn received a tool call")]
    ToolCall,
}

pub async fn run_turn<P: ModelProvider + ?Sized>(
    provider: &P,
    mut request: CompletionRequest,
    watcher: &mut StreamWatcher,
    max_restarts: usize,
) -> Result<String, TurnError> {
    for restart in 0..=max_restarts {
        watcher.reset();
        let mut stream = provider.stream(request.clone()).await?;
        let mut abort = None;
        while let Some(token) = stream.next().await {
            match token? {
                Token::Text(text) => {
                    if let Verdict::Abort {
                        rule, correction, ..
                    } = watcher.push(&text)
                    {
                        abort = Some((rule, correction));
                        break;
                    }
                }
                Token::ToolCall { .. } => return Err(TurnError::ToolCall),
                Token::Finished(_) => break,
                Token::Usage(_) | Token::ExtraContent(_) => {}
            }
        }
        drop(stream);
        match abort {
            None => return Ok(watcher.text().into()),
            Some((rule, _)) if restart == max_restarts => return Err(TurnError::Exhausted(rule)),
            Some((_, correction)) => request
                .messages
                .push(Message::text(Role::System, correction)),
        }
    }
    Err(TurnError::Exhausted("restart limit".into()))
}
