use memmap2::{MmapMut, MmapOptions};
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A memory-mapped Write-Ahead Log for zero-latency append operations.
#[allow(dead_code)]
pub struct Wal {
    file: File,
    mmap: MmapMut,
    /// The current byte offset where the next append should happen
    offset: AtomicUsize,
    capacity: usize,
}

impl Wal {
    /// Creates or opens a WAL file at the given path with a pre-allocated capacity.
    pub fn new<P: AsRef<Path>>(path: P, capacity: usize) -> io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .open(path)?;

        // Ensure the file is at least `capacity` bytes long
        file.set_len(capacity as u64)?;

        let mmap = unsafe { MmapOptions::new().map_mut(&file)? };

        // For simplicity in this early version, we always start appending from offset 0
        // (A fully robust WAL would scan for the EOF marker to resume)
        let offset = AtomicUsize::new(0);

        Ok(Self {
            file,
            mmap,
            offset,
            capacity,
        })
    }

    /// Appends data to the WAL. Returns the offset where the data was written.
    pub fn append(&mut self, data: &[u8]) -> io::Result<usize> {
        let current_offset = self.offset.load(Ordering::SeqCst);
        
        if current_offset + data.len() > self.capacity {
            return Err(io::Error::new(
                io::ErrorKind::OutOfMemory,
                "WAL capacity exceeded",
            ));
        }

        // Copy data into the memory map
        self.mmap[current_offset..current_offset + data.len()].copy_from_slice(data);
        
        // Ensure changes are flushed to disk (can be omitted for max performance, relying on OS)
        self.mmap.flush_range(current_offset, data.len())?;

        // Update the offset
        self.offset.store(current_offset + data.len(), Ordering::SeqCst);

        Ok(current_offset)
    }

    /// Reads data from the WAL.
    pub fn read(&self, start: usize, len: usize) -> Option<&[u8]> {
        if start + len > self.capacity {
            return None;
        }
        Some(&self.mmap[start..start + len])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_wal_append_read() {
        let path = "test_wal.bin";
        let _ = fs::remove_file(path); // Clean up before test
        
        let mut wal = Wal::new(path, 1024).unwrap();
        
        let data1 = b"Hello, ";
        let data2 = b"World!";
        
        let offset1 = wal.append(data1).unwrap();
        assert_eq!(offset1, 0);
        
        let offset2 = wal.append(data2).unwrap();
        assert_eq!(offset2, data1.len());
        
        let read1 = wal.read(offset1, data1.len()).unwrap();
        assert_eq!(read1, data1);
        
        let read2 = wal.read(offset2, data2.len()).unwrap();
        assert_eq!(read2, data2);
        
        let _ = fs::remove_file(path); // Clean up after test
    }
}
