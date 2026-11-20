// 防止 Windows 下显示控制台窗口；macOS 无影响。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    yueduo_lib::run()
}
