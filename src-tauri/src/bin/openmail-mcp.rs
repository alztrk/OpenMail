fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|error| {
            eprintln!("OpenMail MCP runtime could not start: {error}");
            std::process::exit(1);
        });

    if let Err(error) = runtime.block_on(openmail_lib::mcp::run()) {
        eprintln!("OpenMail MCP server stopped: {error}");
        std::process::exit(1);
    }
}
