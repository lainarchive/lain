use std::{
    io::{self, Write},
    process::ExitCode,
    sync::{Arc, Mutex},
};

use lain_cli::{
    args::{Action, Options, USAGE},
    daemon::{ConfigFactory, DaemonHandler},
    ui::{self, Renderer},
    Error,
};
use lain_ipc::{Command, IpcServer};
use lain_memory::MemoryStore;
use tokio::sync::watch;

async fn daemon(options: Options) -> Result<(), Error> {
    let cwd = std::env::current_dir()?;
    let memory = std::env::var_os("LAIN_MEMORY_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| cwd.join(".lain/memory.db"));
    let mut factory = ConfigFactory::new(options.config, cwd);
    factory.allow_shell = std::env::var("LAIN_ALLOW_SHELL").is_ok_and(|value| value == "1");
    let handler = Arc::new(DaemonHandler::new(
        Arc::new(Mutex::new(MemoryStore::open(memory)?)),
        Arc::new(factory),
    ));
    let server = IpcServer::bind(&options.endpoint)?;
    let (shutdown, receiver) = watch::channel(false);
    let http_shutdown = receiver.clone();
    let serve = server.serve(handler.clone(), receiver);
    let http = async {
        if options.serve_ui {
            lain_cli::dashboard::serve(handler.clone(), http_shutdown).await
        } else {
            std::future::pending::<Result<(), Error>>().await
        }
    };
    tokio::pin!(serve);
    tokio::pin!(http);
    tokio::select! {
        result = &mut serve => {
            handler.cancel_all().await;
            let _ = shutdown.send(true);
            result?;
            if options.serve_ui { http.await?; }
        }
        result = &mut http => {
            handler.cancel_all().await;
            let _ = shutdown.send(true);
            serve.await?;
            result?;
        }
        signal = tokio::signal::ctrl_c() => {
            handler.cancel_all().await;
            let _ = shutdown.send(true);
            serve.await?;
            if options.serve_ui { http.await?; }
            signal?;
        }
    }
    Ok(())
}

async fn run() -> Result<bool, Error> {
    let options = Options::parse(std::env::args().skip(1))?;
    if let Action::Tui { demo } = options.action {
        lain_cli::tui::run(&options, demo).await?;
        return Ok(true);
    }
    if options.action == Action::Help {
        write!(io::stdout().lock(), "{USAGE}")?;
        return Ok(true);
    }
    if options.action == Action::Daemon {
        daemon(options).await?;
        return Ok(true);
    }
    let mut client = ui::connect_or_spawn(&options).await?;
    let mut renderer = Renderer::new(options.plain);
    let ok = match options.action {
        Action::Start => {
            ui::interactive(&mut client, &mut renderer).await?;
            true
        }
        Action::Query(prompt) => {
            let session = ui::start_session(&mut client, &mut renderer).await?;
            ui::turn(&mut client, &session, prompt, &mut renderer)
                .await?
                .0
        }
        Action::Memory { limit, session } => {
            ui::request(
                &mut client,
                Command::InspectMemory {
                    session_id: session,
                    limit: Some(limit),
                },
                &mut renderer,
            )
            .await?;
            true
        }
        _ => true,
    };
    client.close().await?;
    Ok(ok)
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            let _ = ui::report_error(&error);
            ExitCode::FAILURE
        }
    }
}
