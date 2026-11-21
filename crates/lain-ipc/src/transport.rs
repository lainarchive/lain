use std::path::PathBuf;

use crate::Error;

pub const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\lain-ipc";

#[derive(Debug, Clone)]
pub struct Endpoint(pub PathBuf);

impl Default for Endpoint {
    fn default() -> Self {
        #[cfg(windows)]
        let path = PathBuf::from(DEFAULT_PIPE_NAME);
        #[cfg(unix)]
        let path = {
            use std::os::unix::fs::MetadataExt;
            let runtime = std::env::var_os("XDG_RUNTIME_DIR")
                .filter(|path| !path.is_empty())
                .map(PathBuf::from);
            let user = std::env::var_os("HOME")
                .and_then(|home| std::fs::metadata(home).ok())
                .map(|metadata| metadata.uid().to_string())
                .or_else(|| std::env::var("UID").ok())
                .or_else(|| std::env::var("USER").ok())
                .unwrap_or_else(|| format!("pid-{}", std::process::id()));
            unix_default_path(runtime, std::env::temp_dir(), &user)
        };
        Self(path)
    }
}

#[cfg(unix)]
fn unix_default_path(runtime: Option<PathBuf>, temporary: PathBuf, user: &str) -> PathBuf {
    if let Some(runtime) = runtime {
        return runtime.join("lain-ipc.sock");
    }
    let user: String = user
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(32)
        .collect();
    let user = if user.is_empty() {
        format!("pid-{}", std::process::id())
    } else {
        user
    };
    temporary.join(format!("lain-ipc-{user}.sock"))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn default_socket_is_runtime_or_user_scoped() {
        assert_eq!(
            unix_default_path(Some("/run/user/1000".into()), "/tmp".into(), "1000"),
            PathBuf::from("/run/user/1000/lain-ipc.sock")
        );
        assert_eq!(
            unix_default_path(None, "/tmp".into(), "1000"),
            PathBuf::from("/tmp/lain-ipc-1000.sock")
        );
        assert_ne!(
            unix_default_path(None, "/tmp".into(), "1000"),
            unix_default_path(None, "/tmp".into(), "1001")
        );
        assert_eq!(
            unix_default_path(None, "/tmp".into(), "alice"),
            PathBuf::from("/tmp/lain-ipc-alice.sock")
        );
        assert!(unix_default_path(None, "/tmp".into(), "../alice").starts_with("/tmp"));
        assert!(unix_default_path(None, "/tmp".into(), "")
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("lain-ipc-pid-")));
    }
}

#[cfg(unix)]
pub(crate) type Stream = tokio::net::UnixStream;
#[cfg(windows)]
pub(crate) type Stream = tokio::net::windows::named_pipe::NamedPipeClient;

pub(crate) async fn connect(endpoint: &Endpoint) -> Result<Stream, Error> {
    #[cfg(unix)]
    {
        Ok(Stream::connect(&endpoint.0).await?)
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        loop {
            match ClientOptions::new().open(&endpoint.0) {
                Ok(client) => return Ok(client),
                Err(error) if error.raw_os_error() == Some(231) => {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

#[cfg(unix)]
#[derive(Debug)]
pub(crate) struct Listener {
    inner: tokio::net::UnixListener,
    path: PathBuf,
}

#[cfg(unix)]
impl Listener {
    pub(crate) fn bind(endpoint: &Endpoint) -> Result<Self, Error> {
        use std::os::unix::fs::FileTypeExt;
        match std::fs::symlink_metadata(&endpoint.0) {
            Ok(metadata) if metadata.file_type().is_socket() => {
                match std::os::unix::net::UnixStream::connect(&endpoint.0) {
                    Ok(_) => {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::AddrInUse,
                            "Endpoint is already listening",
                        )
                        .into())
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
                        std::fs::remove_file(&endpoint.0)?
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            Ok(_) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "Endpoint is not a socket",
                )
                .into())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(Self {
            inner: tokio::net::UnixListener::bind(&endpoint.0)?,
            path: endpoint.0.clone(),
        })
    }

    pub(crate) async fn accept(&mut self) -> Result<Stream, Error> {
        Ok(self.inner.accept().await?.0)
    }
}

#[cfg(unix)]
impl Drop for Listener {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(windows)]
#[derive(Debug)]
pub(crate) struct Listener {
    next: tokio::net::windows::named_pipe::NamedPipeServer,
    path: PathBuf,
}

#[cfg(windows)]
impl Listener {
    pub(crate) fn bind(endpoint: &Endpoint) -> Result<Self, Error> {
        use tokio::net::windows::named_pipe::ServerOptions;
        Ok(Self {
            next: ServerOptions::new()
                .first_pipe_instance(true)
                .create(&endpoint.0)?,
            path: endpoint.0.clone(),
        })
    }

    pub(crate) async fn accept(
        &mut self,
    ) -> Result<tokio::net::windows::named_pipe::NamedPipeServer, Error> {
        self.next.connect().await?;
        let next = tokio::net::windows::named_pipe::ServerOptions::new().create(&self.path)?;
        Ok(std::mem::replace(&mut self.next, next))
    }
}
