use std::io::{self, Write};

fn main() -> io::Result<()> {
    io::stdout()
        .lock()
        .write_all(lain_cli::dashboard::typescript_contracts().as_bytes())
}
