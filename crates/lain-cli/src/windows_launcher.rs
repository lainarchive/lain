use std::path::Path;

use crate::Error;

fn windows_argument(argument: &str) -> String {
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for c in argument.chars() {
        if c == '\\' {
            slashes += 1;
        } else {
            quoted.push_str(&"\\".repeat(if c == '"' { slashes * 2 + 1 } else { slashes }));
            quoted.push(c);
            slashes = 0;
        }
    }
    quoted.push_str(&"\\".repeat(slashes * 2));
    quoted.push('"');
    quoted
}

fn powershell_literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn launch_script(
    exe: &Path,
    endpoint: &Path,
    config: &Path,
    cwd: &Path,
    log: &Path,
) -> Result<String, Error> {
    let path_text = |path: &Path| {
        path.to_str().map(str::to_owned).ok_or_else(|| {
            Error::failure(
                "DAEMON_LAUNCH_PATH",
                "Windows launcher paths must be valid Unicode",
            )
        })
    };
    let exe = path_text(exe)?;
    let endpoint = path_text(endpoint)?;
    let config = path_text(config)?;
    let cwd = path_text(cwd)?;
    let log = path_text(log)?;
    let arguments = ["daemon", "--endpoint", &endpoint, "--config", &config]
        .into_iter()
        .map(windows_argument)
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!(
        "$ErrorActionPreference = 'Stop'; Start-Process -FilePath {} -ArgumentList {} -WorkingDirectory {} -WindowStyle Hidden -RedirectStandardError {}",
        powershell_literal(&exe), powershell_literal(&arguments), powershell_literal(&cwd), powershell_literal(&log),
    ))
}

fn encoded_command(script: &str) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut encoded = String::new();
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk.first().copied().unwrap_or(0)) << 16)
            | (u32::from(chunk.get(1).copied().unwrap_or(0)) << 8)
            | u32::from(chunk.get(2).copied().unwrap_or(0));
        for (position, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if position > chunk.len() {
                encoded.push('=');
            } else if let Some(&digit) = ALPHABET.get(((value >> shift) & 63) as usize) {
                encoded.push(char::from(digit));
            }
        }
    }
    encoded
}

#[cfg(windows)]
pub(crate) fn command(
    exe: &Path,
    endpoint: &Path,
    config: &Path,
    log: &Path,
) -> Result<std::process::Command, Error> {
    let root = std::env::var_os("SystemRoot").ok_or_else(|| {
        Error::failure(
            "DAEMON_LAUNCH_PATH",
            "SystemRoot is required to locate Windows PowerShell",
        )
    })?;
    let powershell =
        std::path::PathBuf::from(root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut command = std::process::Command::new(powershell);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
        ])
        .arg(encoded_command(&launch_script(
            exe,
            endpoint,
            config,
            &std::env::current_dir()?,
            log,
        )?));
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_arguments_preserve_spaces_quotes_and_trailing_slashes() {
        for (input, expected) in [
            ("", "\"\""),
            ("daemon", "\"daemon\""),
            ("a b", "\"a b\""),
            ("a\"b", "\"a\\\"b\""),
            ("a\\\"b", "\"a\\\\\\\"b\""),
            ("C:\\trailing space\\", "\"C:\\trailing space\\\\\""),
        ] {
            assert_eq!(windows_argument(input), expected);
        }
    }

    #[test]
    fn script_keeps_paths_and_metacharacters_literal() -> Result<(), Error> {
        let script = launch_script(
            Path::new(r"C:\space ' é\lain.exe"),
            Path::new(r"\\.\pipe\lain-$`;,()"),
            Path::new(r"C:\config ' $x; stop-process.json"),
            Path::new(r"C:\working ' é"),
            Path::new(r"C:\state ' é\daemon.log"),
        )?;
        assert_eq!(script, concat!(
            "$ErrorActionPreference = 'Stop'; Start-Process -FilePath 'C:\\space '' é\\lain.exe' ",
            "-ArgumentList '\"daemon\" \"--endpoint\" \"\\\\.\\pipe\\lain-$`;,()\" ",
            "\"--config\" \"C:\\config '' $x; stop-process.json\"' -WorkingDirectory 'C:\\working '' é' -WindowStyle Hidden ",
            "-RedirectStandardError 'C:\\state '' é\\daemon.log'",
        ));
        Ok(())
    }

    #[test]
    fn powershell_encoding_is_utf16le_base64() {
        assert_eq!(encoded_command(""), "");
        assert_eq!(encoded_command("A"), "QQA=");
        assert_eq!(encoded_command("AB"), "QQBCAA==");
        assert_eq!(encoded_command("ABC"), "QQBCAEMA");
        assert_eq!(encoded_command("é"), "6QA=");
        assert_eq!(encoded_command("😀"), "PdgA3g==");
    }

    #[cfg(unix)]
    #[test]
    fn non_unicode_paths_are_rejected() {
        use std::os::unix::ffi::OsStrExt;
        let invalid = Path::new(std::ffi::OsStr::from_bytes(b"\xff"));
        assert!(launch_script(
            invalid,
            Path::new("pipe"),
            Path::new("config"),
            Path::new("cwd"),
            Path::new("log")
        )
        .is_err());
    }

    #[cfg(windows)]
    #[test]
    fn non_unicode_paths_are_rejected() {
        use std::os::windows::ffi::OsStringExt;
        let invalid = std::path::PathBuf::from(std::ffi::OsString::from_wide(&[0xd800]));
        assert!(launch_script(
            &invalid,
            Path::new("pipe"),
            Path::new("config"),
            Path::new("cwd"),
            Path::new("log")
        )
        .is_err());
    }
}
