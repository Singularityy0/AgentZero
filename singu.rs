// File: singu.rs

// Bubble Sort implementation
fn bubble_sort(arr: &mut [i32]) {
    let n = arr.len();
    for i in 0..n {
        for j in 0..(n - i - 1) {
            if arr[j] > arr[j + 1] {
                arr.swap(j, j + 1);
            }
        }
    }
}

// Example usage
fn main() {
    let mut data = vec![34, 7, 23, 32, 5, 62];
    bubble_sort(&mut data);
    println!("Sorted array: {:?}", data);
}