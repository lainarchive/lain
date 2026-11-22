mod app;
mod creator;
mod creator_ipc;
mod creator_view;
mod demo;
mod input;
mod inspect;
mod launch_view;
mod plugins;
mod shell_view;
mod state;
mod theme;
mod transcript;
mod view;

pub use input::run;

#[cfg(test)]
mod tests;
