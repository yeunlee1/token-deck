// Windows 데스크톱 애플리케이션 프로세스를 시작하는 진입점
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    token_deck_lib::run();
}
