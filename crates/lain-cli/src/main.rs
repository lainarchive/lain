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
    let handler = Arc::new(DaemonHandler::new(
        Arc::new(Mutex::new(MemoryStore::open(memory)?)),
        Arc::new(ConfigFactory {
            config_path: options.config,
            working_directory: cwd,
        }),
    ));
    let server = IpcServer::bind(&options.endpoint)?;
    let (shutdown, receiver) = watch::channel(false);
    let serve = server.serve(handler.clone(), receiver);
    tokio::pin!(serve);
    tokio::select! {
        result = &mut serve => result?,
        signal = tokio::signal::ctrl_c() => {
            signal?;
            handler.cancel_all().await;
            let _ = shutdown.send(true);
            serve.await?;
        }
    }
    Ok(())
}

async fn run() -> Result<bool, Error> {
    let options = Options::parse(std::env::args().skip(1))?;
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
