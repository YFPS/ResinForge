fn main() {
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fallback = manifest.join("../src-tauri/target/release/bundle/nsis/ResinForge_0.3.3_x64-setup.exe");
    let path = std::env::var("NSIS_PATH").unwrap_or_else(|_| fallback.to_string_lossy().into_owned());
    let path = path.replace('\\', "/");
    if !std::path::Path::new(&path).is_file() {
        panic!("找不到静默安装包，先打 NSIS：{path}");
    }
    println!("cargo:rustc-env=NSIS_FILE={path}");
    println!("cargo:rerun-if-changed={path}");
}
