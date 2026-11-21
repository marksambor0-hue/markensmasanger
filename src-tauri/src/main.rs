//! MARKENS Desktop Native Rust Backend (Tauri v2 — v31.11.1)
use std::process::Command;

pub fn detect_running_games_rust() -> Option<String> {
    if cfg!(target_os = "windows") {
        if let Ok(output) = Command::new("tasklist").arg("/nh").output() {
            let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
            let games = [
                ("cs2.exe", "Counter-Strike 2"),
                ("deadlock.exe", "Deadlock"),
                ("project8.exe", "Deadlock"),
                ("discovery.exe", "THE FINALS"),
                ("dota2.exe", "Dota 2"),
                ("valorant.exe", "Valorant"),
                ("gta5.exe", "Grand Theft Auto V"),
                ("rustclient.exe", "Rust"),
                ("r5apex.exe", "Apex Legends"),
                ("cyberpunk2077.exe", "Cyberpunk 2077"),
            ];
            for (exe, title) in games {
                if stdout.contains(exe) {
                    return Some(title.to_string());
                }
            }
        }
    }
    None
}

fn main() {
    println!("MARKENS Native Rust Engine v31.11.1 initialized (BUILD_TS=1796600000000)");
}
