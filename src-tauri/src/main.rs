// Windows 데스크톱 애플리케이션 프로세스를 시작하는 진입점
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args_os().any(|argument| argument == "--claude-statusline") {
        if let Err(error) = token_deck_lib::run_claude_statusline_capture() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    token_deck_lib::run();
}
