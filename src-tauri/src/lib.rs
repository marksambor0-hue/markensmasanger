//! MARKENS Native Rust + WebAssembly Core (v31.11.1)
//! Compiled to wasm32-unknown-unknown and embedded directly into index.html

#[no_mangle]
pub unsafe extern "C" fn wasm_xor_cipher(data_ptr: *mut u8, key_ptr: *const u8, len: usize) {
    let mut i = 0usize;
    while i < len {
        let d = *data_ptr.add(i);
        let k = *key_ptr.add(i);
        *data_ptr.add(i) = d ^ k;
        i += 1;
    }
}

#[no_mangle]
pub unsafe extern "C" fn wasm_voice_energy_sum(bins_ptr: *const u8, count: usize) -> u32 {
    if count <= 1 {
        return 0;
    }
    let mut sum: u32 = 0;
    let mut i = 1usize;
    while i < count {
        sum += (*bins_ptr.add(i)) as u32;
        i += 1;
    }
    sum
}

#[no_mangle]
pub unsafe extern "C" fn wasm_fnv1a_32(ptr: *const u8, len: usize) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    let mut i = 0usize;
    while i < len {
        hash ^= (*ptr.add(i)) as u32;
        hash = hash.wrapping_mul(0x01000193);
        i += 1;
    }
    hash
}
