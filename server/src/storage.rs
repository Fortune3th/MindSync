//! Directory-fd anchored I/O: every component is opened with O_NOFOLLOW.
use sha2::{Digest, Sha256};
use std::{
    ffi::{CStr, CString},
    fs::File,
    io::{self, Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    path::Path,
    sync::Arc,
};
use uuid::Uuid;
#[derive(Clone)]
pub struct Dir(Arc<File>);
fn name(s: &str) -> io::Result<CString> {
    CString::new(s).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid name"))
}
fn check(rc: libc::c_int) -> io::Result<libc::c_int> {
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(rc)
    }
}
impl Dir {
    pub fn root(path: &Path) -> io::Result<Self> {
        let mut dir = Self(Arc::new(File::open(if path.is_absolute() {
            "/"
        } else {
            "."
        })?));
        for part in path.components() {
            use std::path::Component;
            match part {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(p) => {
                    dir = dir.child(
                        p.to_str().ok_or_else(|| io::Error::other("invalid root"))?,
                        true,
                    )?
                }
                _ => return Err(io::Error::other("invalid root")),
            }
        }
        Ok(dir)
    }
    pub fn child(&self, s: &str, create: bool) -> io::Result<Self> {
        let n = name(s)?;
        if create {
            let rc = unsafe { libc::mkdirat(self.0.as_raw_fd(), n.as_ptr(), 0o700) };
            if rc < 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                return Err(io::Error::last_os_error());
            }
            if rc == 0 {
                self.sync()?
            }
        }
        let fd = check(unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                n.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        })?;
        Ok(Self(Arc::new(unsafe { File::from_raw_fd(fd) })))
    }
    pub fn parent(&self, path: &str, create: bool) -> io::Result<(Self, String)> {
        let mut parts = path.split('/').collect::<Vec<_>>();
        let leaf = parts
            .pop()
            .ok_or_else(|| io::Error::other("empty path"))?
            .to_owned();
        let mut dir = self.clone();
        for p in parts {
            dir = dir.child(p, create)?
        }
        Ok((dir, leaf))
    }
    pub fn open(&self, s: &str) -> io::Result<File> {
        self.open_flags(s, libc::O_RDONLY)
    }
    pub fn create(&self, s: &str) -> io::Result<File> {
        self.open_flags(s, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)
    }
    fn open_flags(&self, s: &str, flags: i32) -> io::Result<File> {
        let n = name(s)?;
        let fd = check(unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                n.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                0o600,
            )
        })?;
        let file = unsafe { File::from_raw_fd(fd) };
        if !file.metadata()?.is_file() {
            return Err(io::Error::other("not a regular file"));
        }
        Ok(file)
    }
    pub fn sync(&self) -> io::Result<()> {
        self.0.sync_all()
    }
    pub fn remove(&self, s: &str, directory: bool) -> io::Result<()> {
        let n = name(s)?;
        check(unsafe {
            libc::unlinkat(
                self.0.as_raw_fd(),
                n.as_ptr(),
                if directory { libc::AT_REMOVEDIR } else { 0 },
            )
        })?;
        self.sync()
    }
    pub fn rename(&self, s: &str, dest: &Self, to: &str) -> io::Result<()> {
        let s = name(s)?;
        let t = name(to)?;
        check(unsafe {
            libc::renameat(
                self.0.as_raw_fd(),
                s.as_ptr(),
                dest.0.as_raw_fd(),
                t.as_ptr(),
            )
        })?;
        dest.sync()?;
        self.sync()
    }
    pub fn link(&self, s: &str, dest: &Self, to: &str) -> io::Result<()> {
        let s = name(s)?;
        let t = name(to)?;
        check(unsafe {
            libc::linkat(
                self.0.as_raw_fd(),
                s.as_ptr(),
                dest.0.as_raw_fd(),
                t.as_ptr(),
                0,
            )
        })?;
        dest.sync()
    }
    pub fn names(&self) -> io::Result<Vec<String>> {
        // Opening "." creates an independent directory offset (dup would share it).
        let n = name(".")?;
        let fd = check(unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                n.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        })?;
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            unsafe { libc::close(fd) };
            return Err(io::Error::last_os_error());
        }
        let mut names = Vec::new();
        loop {
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            let s = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
                .to_str()
                .map_err(|_| io::Error::other("invalid filename"));
            match s {
                Ok("." | "..") => {}
                Ok(s) => names.push(s.to_string()),
                Err(e) => {
                    unsafe { libc::closedir(stream) };
                    return Err(e);
                }
            }
        }
        unsafe { libc::closedir(stream) };
        Ok(names)
    }
    pub fn clear(&self) -> io::Result<()> {
        for n in self.names()? {
            match self.child(&n, false) {
                Ok(child) => {
                    child.clear()?;
                    self.remove(&n, true)?
                }
                Err(_) => self.remove(&n, false)?,
            }
        }
        Ok(())
    }
    // Historical deletions can leave a tree of empty directories. Never remove
    // a regular file or follow a symlink when converting that tree into a file.
    pub fn clear_empty_directories(&self) -> io::Result<()> {
        for name in self.names()? {
            let child = self.child(&name, false)?;
            child.clear_empty_directories()?;
            self.remove(&name, true)?;
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct Storage {
    pub root: Dir,
    pub objects: Dir,
    pub vault: Dir,
    pub configuration: Dir,
    pub tmp: Dir,
}
pub struct Temporary {
    pub dir: Dir,
    pub name: String,
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = self.dir.remove(&self.name, false);
    }
}
impl Storage {
    pub fn for_scope(&self, scope: crate::configuration::Scope) -> Self {
        let mut storage = self.clone();
        if scope == crate::configuration::Scope::Configuration {
            storage.vault = self.configuration.clone();
        }
        storage
    }
    pub fn new(path: &Path) -> io::Result<Self> {
        let root = Dir::root(path)?;
        Ok(Self {
            objects: root.child("objects", true)?,
            vault: root.child("vault", true)?,
            configuration: root.child("configuration", true)?,
            tmp: root.child("tmp", true)?,
            root,
        })
    }
    pub fn temporary(&self) -> io::Result<(Temporary, File)> {
        let name = Uuid::new_v4().to_string();
        let file = self.tmp.create(&name)?;
        Ok((
            Temporary {
                dir: self.tmp.clone(),
                name,
            },
            file,
        ))
    }
    pub fn verify(&self, hash: &str, size: Option<i64>) -> io::Result<File> {
        let mut file = self.objects.open(hash)?;
        if size.is_some_and(|s| file.metadata().map(|m| m.len() != s as u64).unwrap_or(true)) {
            return Err(io::Error::other("object size mismatch"));
        }
        let mut h = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = file.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            h.update(&buffer[..n])
        }
        if hex::encode(h.finalize()) != hash {
            return Err(io::Error::other("object checksum mismatch"));
        }
        use std::io::Seek;
        file.rewind()?;
        Ok(file)
    }
    pub fn publish(&self, temp: &Temporary, hash: &str, size: i64) -> io::Result<()> {
        match self.tmp.link(&temp.name, &self.objects, hash) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                self.verify(hash, Some(size)).map(|_| ())
            }
            Err(e) => Err(e),
        }
    }
    pub fn touch(&self, hash: &str) -> io::Result<()> {
        let file = self.objects.open(hash)?;
        file.set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()))?;
        file.sync_all()
    }
    pub fn verify_manifest(
        &self,
        hash: &str,
        size: i64,
        chunks: &[(String, i64)],
    ) -> io::Result<bool> {
        let mut hasher = Sha256::new();
        let mut total = 0u64;
        let mut buffer = [0u8; 65536];
        for (chunk_hash, chunk_size) in chunks {
            let mut object = self.verify(chunk_hash, Some(*chunk_size))?;
            loop {
                let n = object.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                total = total
                    .checked_add(n as u64)
                    .ok_or_else(|| io::Error::other("manifest too large"))?;
                hasher.update(&buffer[..n]);
            }
        }
        Ok(total == size as u64 && hex::encode(hasher.finalize()) == hash)
    }
    pub fn projection_chunks(
        &self,
        path: &str,
        hash: &str,
        size: i64,
        chunks: &[(String, i64)],
    ) -> io::Result<()> {
        if !self.verify_manifest(hash, size, chunks)? {
            return Err(io::Error::other("manifest checksum mismatch"));
        }
        let (parent, leaf) = self.vault.parent(path, true)?;
        let temp_name = format!(".mindsync-{}", Uuid::new_v4());
        let mut file = parent.create(&temp_name)?;
        let result = (|| {
            for (hash, size) in chunks {
                let mut object = self.verify(hash, Some(*size))?;
                io::copy(&mut object, &mut file)?;
            }
            file.flush()?;
            file.sync_all()?;
            if let Ok(directory) = parent.child(&leaf, false) {
                directory.clear_empty_directories()?;
                parent.remove(&leaf, true)?;
            }
            parent.rename(&temp_name, &parent, &leaf)
        })();
        if result.is_err() {
            let _ = parent.remove(&temp_name, false);
        }
        result
    }
    pub fn projection(&self, path: &str, hash: &str, size: i64) -> io::Result<()> {
        let mut object = self.verify(hash, Some(size))?;
        let (parent, leaf) = self.vault.parent(path, true)?;
        let temp_name = format!(".mindsync-{}", Uuid::new_v4());
        let mut file = parent.create(&temp_name)?;
        let result = (|| {
            io::copy(&mut object, &mut file)?;
            file.flush()?;
            file.sync_all()?;
            if let Ok(directory) = parent.child(&leaf, false) {
                directory.clear_empty_directories()?;
                parent.remove(&leaf, true)?;
            }
            parent.rename(&temp_name, &parent, &leaf)
        })();
        if result.is_err() {
            let _ = parent.remove(&temp_name, false);
        }
        result
    }
    pub fn remove_projection(&self, path: &str) -> io::Result<()> {
        self.remove_projection_entry(path, false)
    }
    pub fn remove_ancestor_projection(&self, path: &str) -> io::Result<()> {
        self.remove_projection_entry(path, true)
    }
    fn remove_projection_entry(&self, path: &str, keep_directory: bool) -> io::Result<()> {
        match self.vault.parent(path, false) {
            Ok((parent, leaf)) => {
                if let Ok(directory) = parent.child(&leaf, false) {
                    if keep_directory {
                        return Ok(());
                    }
                    directory.clear_empty_directories()?;
                    return parent.remove(&leaf, true);
                }
                match parent.remove(&leaf, false) {
                    Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
                    result => result,
                }
            }
            // An obsolete descendant cannot exist under a now-current file.
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) =>
            {
                Ok(())
            }
            Err(e) => Err(e),
        }
    }
    pub fn usage(&self) -> io::Result<u64> {
        let mut size = 0;
        for n in self.objects.names()? {
            size += self.objects.open(&n)?.metadata()?.len()
        }
        Ok(size)
    }
    pub fn health(&self) -> io::Result<()> {
        self.root.child("objects", false)?;
        self.root.child("vault", false)?;
        self.root.child("tmp", false)?;
        let (_temp, mut file) = self.temporary()?;
        file.write_all(b"health")?;
        file.sync_all()?;
        self.tmp.sync()
    }
}
