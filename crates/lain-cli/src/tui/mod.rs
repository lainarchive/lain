mod app;
mod bots;
mod creator;
mod creator_ipc;
mod creator_view;
mod demo;
mod formatting;
mod input;
mod inspect;
mod launch_view;
mod plugins;
mod reconnect;
mod shell_view;
mod state;
mod theme;
mod transcript;
mod view;

pub use input::run;

#[cfg(test)]
mod tests;
