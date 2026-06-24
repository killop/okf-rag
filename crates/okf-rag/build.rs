use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(|path| path.parent())
        .expect("crate should live under crates/okf-rag");
    let zvec_dir = repo_root.join("third_party/zvec-prebuilt-x86_64-pc-windows-msvc");
    let zvec_dll_path = zvec_dir.join("zvec_c_api.dll");
    let ort_lib_dir = repo_root
        .join("third_party")
        .join("onnxruntime")
        .join("lib");
    let ort_dll_path = ort_lib_dir.join("onnxruntime.dll");

    println!("cargo:rerun-if-changed={}", zvec_dll_path.display());
    println!("cargo:rerun-if-changed={}", ort_dll_path.display());
    println!("cargo:rustc-link-search=native={}", zvec_dir.display());

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    if let Some(profile_dir) = out_dir.ancestors().nth(3) {
        for target_dir in [profile_dir.to_path_buf(), profile_dir.join("deps")] {
            copy_dll(&zvec_dll_path, &target_dir.join("zvec_c_api.dll"));
            copy_dlls_from_dir(&ort_lib_dir, &target_dir);
        }
    }
}

fn copy_dll(source: &Path, target: &Path) {
    if !source.exists() {
        return;
    }
    if let Err(err) = fs::copy(source, target) {
        println!(
            "cargo:warning=failed to copy {} to {}: {}",
            source.display(),
            target.display(),
            err
        );
    }
}

fn copy_dlls_from_dir(source_dir: &Path, target_dir: &Path) {
    let Ok(entries) = fs::read_dir(source_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let source = entry.path();
        if source.extension().and_then(|ext| ext.to_str()) != Some("dll") {
            continue;
        }
        if let Some(name) = source.file_name() {
            copy_dll(&source, &target_dir.join(name));
        }
    }
}
