//! The map image cache: files in `<data dir>/map-tiles/<source>/<z>/<x>/<y>.<ext>`, bounded in
//! size and age. Each server keeps its own; the index of what is on disk lives in memory and is
//! read from the folder once per source.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};

use crate::locks::MutexExt;

/// The folder below the data directory.
pub const DIR: &str = "map-tiles";

/// The image formats map images come in; anything else is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Png,
    Jpeg,
    Webp,
}

impl Format {
    pub const ALL: [Format; 3] = [Format::Png, Format::Jpeg, Format::Webp];

    /// The format the first bytes say, whatever the source's header claimed.
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
            Some(Format::Png)
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            Some(Format::Jpeg)
        } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            Some(Format::Webp)
        } else {
            None
        }
    }

    pub fn content_type(self) -> &'static str {
        match self {
            Format::Png => "image/png",
            Format::Jpeg => "image/jpeg",
            Format::Webp => "image/webp",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Format::Png => "png",
            Format::Jpeg => "jpg",
            Format::Webp => "webp",
        }
    }

    fn from_extension(ext: &str) -> Option<Self> {
        Format::ALL.into_iter().find(|f| f.extension() == ext)
    }
}

/// One map image: zoom, column, row.
pub type TileId = (u8, u32, u32);

#[derive(Clone, Copy, Debug)]
struct Entry {
    size: u64,
    /// When it was fetched, Unix ms.
    at_ms: i64,
    format: Format,
}

/// Where a source's images are kept: its folder and the generation of the setting it was read
/// in (`Map::generation`). A request that still holds an older source never touches the folder
/// of a newer one.
#[derive(Clone, Copy, Debug)]
pub struct Place<'a> {
    pub dir: &'a str,
    pub generation: u64,
}

#[derive(Default)]
struct Index {
    /// The source folder this index describes (`source_dir`).
    source: String,
    /// The generation of the setting that source belongs to.
    generation: u64,
    entries: HashMap<TileId, Entry>,
    /// Oldest first, for evicting.
    by_age: BTreeSet<(i64, TileId)>,
    total: u64,
}

impl Index {
    fn insert(&mut self, id: TileId, entry: Entry) {
        self.remove(id);
        self.total += entry.size;
        self.by_age.insert((entry.at_ms, id));
        self.entries.insert(id, entry);
    }

    fn remove(&mut self, id: TileId) -> Option<Entry> {
        let entry = self.entries.remove(&id)?;
        self.by_age.remove(&(entry.at_ms, id));
        self.total -= entry.size;
        Some(entry)
    }
}

/// What the cache holds now, for the settings page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub bytes: u64,
    pub tiles: u64,
}

#[derive(Default)]
pub struct TileCache {
    index: Mutex<Option<Index>>,
    /// The newest generation any caller has shown; older callers are stale.
    newest: AtomicU64,
}

/// Numbers the part files, so two writes of one image never share one.
static PART: AtomicU64 = AtomicU64::new(0);

/// The folder name of a source: changing the address starts an empty cache.
pub fn source_dir(url_template: &str) -> String {
    hex::encode(&Sha256::digest(url_template.as_bytes())[..8])
}

fn tile_path(root: &Path, source: &str, id: TileId, format: Format) -> PathBuf {
    root.join(source).join(id.0.to_string()).join(id.1.to_string()).join(format!("{}.{}", id.2, format.extension()))
}

/// Reads what is on disk for `source` and deletes the folders of every other source.
fn scan(root: &Path, source: &str, generation: u64) -> Index {
    let mut index = Index { source: source.to_string(), generation, ..Index::default() };
    let Ok(sources) = std::fs::read_dir(root) else { return index };
    for dir in sources.flatten() {
        if dir.file_name().to_string_lossy() != source {
            let _ = std::fs::remove_dir_all(dir.path());
        }
    }
    let numbered = |dir: &Path| -> Vec<(u32, PathBuf)> {
        let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
        read.flatten().filter_map(|e| Some((e.file_name().to_str()?.parse().ok()?, e.path()))).collect()
    };
    for (z, z_dir) in numbered(&root.join(source)) {
        let Ok(z) = u8::try_from(z) else { continue };
        for (x, x_dir) in numbered(&z_dir) {
            let Ok(files) = std::fs::read_dir(&x_dir) else { continue };
            for file in files.flatten() {
                let name = file.file_name();
                let Some((y, ext)) = name.to_str().and_then(|n| n.split_once('.')) else {
                    let _ = std::fs::remove_file(file.path());
                    continue;
                };
                let (Ok(y), Some(format)) = (y.parse::<u32>(), Format::from_extension(ext)) else {
                    // A partly written file of a server that stopped mid-write.
                    let _ = std::fs::remove_file(file.path());
                    continue;
                };
                let Ok(meta) = file.metadata() else { continue };
                let at_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
                index.insert((z, x, y), Entry { size: meta.len(), at_ms, format });
            }
        }
    }
    index
}

impl TileCache {
    /// Runs `f` on the index of `source`, reading the folder first when the index is of another
    /// source or not read yet. `None`, without touching anything, when the index is of a newer
    /// generation than `place`: the caller holds a source that is no longer in force. Blocking:
    /// callers are on a blocking thread.
    fn with_index<T>(&self, root: &Path, place: Place<'_>, f: impl FnOnce(&mut Index) -> T) -> Option<T> {
        let mut guard = self.index.lock_or_recover();
        let newest = self.newest.fetch_max(place.generation, Ordering::SeqCst).max(place.generation);
        if place.generation < newest {
            return None;
        }
        if guard.as_ref().is_none_or(|i| i.source != place.dir || i.generation < place.generation) {
            *guard = Some(scan(root, place.dir, place.generation));
        }
        Some(f(guard.as_mut().expect("the index was just set")))
    }

    /// The image of `id` when the cache has one younger than `ttl_ms`. An older one is deleted.
    pub async fn get(
        self: &std::sync::Arc<Self>,
        data_dir: &Path,
        place: Place<'_>,
        id: TileId,
        now_ms: i64,
        ttl_ms: i64,
    ) -> Option<(Vec<u8>, Format)> {
        let (cache, root, source, generation) =
            (self.clone(), data_dir.join(DIR), place.dir.to_string(), place.generation);
        tokio::task::spawn_blocking(move || {
            let place = Place { dir: &source, generation };
            let entry = cache.with_index(&root, place, |index| {
                let entry = *index.entries.get(&id)?;
                if now_ms.saturating_sub(entry.at_ms) >= ttl_ms {
                    index.remove(id);
                    let _ = std::fs::remove_file(tile_path(&root, &source, id, entry.format));
                    return None;
                }
                Some(entry)
            })??;
            match std::fs::read(tile_path(&root, &source, id, entry.format)) {
                Ok(bytes) => Some((bytes, entry.format)),
                Err(_) => {
                    // Deleted behind Kalzit's back: the index follows.
                    cache.with_index(&root, place, |index| index.remove(id));
                    None
                }
            }
        })
        .await
        .ok()
        .flatten()
    }

    /// Keeps an image and deletes the oldest ones until the cache is at most `max_bytes`. An
    /// image larger than the whole cache is not kept. A failed write only costs the next fetch.
    #[expect(clippy::too_many_arguments, reason = "one image with where and when it is kept")]
    pub async fn put(
        self: &std::sync::Arc<Self>,
        data_dir: &Path,
        place: Place<'_>,
        id: TileId,
        bytes: Vec<u8>,
        format: Format,
        now_ms: i64,
        max_bytes: u64,
    ) {
        let size = bytes.len() as u64;
        if size > max_bytes {
            return;
        }
        let (cache, root, source, generation) =
            (self.clone(), data_dir.join(DIR), place.dir.to_string(), place.generation);
        let written = tokio::task::spawn_blocking(move || {
            let place = Place { dir: &source, generation };
            // A source no longer in force keeps nothing.
            if cache.with_index(&root, place, |_| ()).is_none() {
                return Ok(());
            }
            let path = tile_path(&root, &source, id, format);
            let dir = path.parent().expect("an image has a folder");
            std::fs::create_dir_all(dir)?;
            // Written beside under a name of its own and renamed, so a reader never sees half an
            // image and two writes of one image never write into the same file.
            let n = PART.fetch_add(1, Ordering::Relaxed);
            let part = dir.join(format!("{}.part-{}-{n}", id.2, std::process::id()));
            std::fs::write(&part, &bytes)?;
            if let Err(e) = std::fs::rename(&part, &path) {
                let _ = std::fs::remove_file(&part);
                return Err(e);
            }
            cache.with_index(&root, place, |index| {
                if let Some(old) = index.remove(id).filter(|old| old.format != format) {
                    let _ = std::fs::remove_file(tile_path(&root, &source, id, old.format));
                }
                index.insert(id, Entry { size, at_ms: now_ms, format });
                while index.total > max_bytes {
                    let Some(&(_, oldest)) = index.by_age.first() else { break };
                    if let Some(gone) = index.remove(oldest) {
                        let _ = std::fs::remove_file(tile_path(&root, &source, oldest, gone.format));
                    }
                }
            });
            Ok::<(), std::io::Error>(())
        })
        .await;
        if let Ok(Err(e)) = written {
            tracing::warn!("a map image could not be kept in the cache: {e}");
        }
    }

    /// What the cache of `source` holds.
    pub async fn usage(self: &std::sync::Arc<Self>, data_dir: &Path, place: Place<'_>) -> Usage {
        let (cache, root, source, generation) =
            (self.clone(), data_dir.join(DIR), place.dir.to_string(), place.generation);
        tokio::task::spawn_blocking(move || {
            let place = Place { dir: &source, generation };
            cache.with_index(&root, place, |index| Usage { bytes: index.total, tiles: index.entries.len() as u64 })
        })
        .await
        .ok()
        .flatten()
        .unwrap_or_default()
    }

    /// Deletes every kept image (the map images were switched off).
    pub async fn clear(self: &std::sync::Arc<Self>, data_dir: &Path) {
        let (cache, root) = (self.clone(), data_dir.join(DIR));
        let _ = tokio::task::spawn_blocking(move || {
            let mut guard = cache.index.lock_or_recover();
            *guard = None;
            if root.exists()
                && let Err(e) = std::fs::remove_dir_all(&root)
            {
                tracing::warn!("the map image cache could not be deleted: {e}");
            }
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

    fn at(dir: &str, generation: u64) -> Place<'_> {
        Place { dir, generation }
    }

    fn image(len: usize) -> Vec<u8> {
        let mut bytes = PNG.to_vec();
        bytes.resize(len, 7);
        bytes
    }

    #[test]
    fn formats_are_told_by_their_first_bytes() {
        assert_eq!(Format::sniff(&PNG), Some(Format::Png));
        assert_eq!(Format::sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some(Format::Jpeg));
        assert_eq!(Format::sniff(b"RIFF\x10\0\0\0WEBPVP8 "), Some(Format::Webp));
        assert_eq!(Format::sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\">"), None);
        assert_eq!(Format::sniff(b"<html>"), None);
        assert_eq!(Format::sniff(b""), None);
    }

    #[tokio::test]
    async fn the_cache_stays_within_its_size_and_drops_the_oldest() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(TileCache::default());
        let source = source_dir("https://tiles.example/{z}/{x}/{y}.png");
        for i in 0..5u32 {
            cache
                .put(dir.path(), at(&source, 0), (3, i, 0), image(400), Format::Png, 1_000 + i64::from(i), 1_000)
                .await;
        }
        let usage = cache.usage(dir.path(), at(&source, 0)).await;
        assert_eq!(usage, Usage { bytes: 800, tiles: 2 }, "two images of 400 bytes fit into 1000");
        assert!(cache.get(dir.path(), at(&source, 0), (3, 0, 0), 2_000, 60_000).await.is_none(), "the oldest went");
        assert!(cache.get(dir.path(), at(&source, 0), (3, 4, 0), 2_000, 60_000).await.is_some(), "the newest stays");
        let on_disk = std::fs::read_dir(dir.path().join(DIR).join(&source).join("3")).unwrap().count();
        assert_eq!(on_disk, 5, "column folders stay");
        let files: usize = (0..5u32)
            .map(|i| tile_path(&dir.path().join(DIR), &source, (3, i, 0), Format::Png).exists() as usize)
            .sum();
        assert_eq!(files, 2, "the files of dropped images are deleted");
        // One image larger than the whole cache is not kept.
        cache.put(dir.path(), at(&source, 0), (4, 0, 0), image(2_000), Format::Png, 3_000, 1_000).await;
        assert!(cache.get(dir.path(), at(&source, 0), (4, 0, 0), 3_000, 60_000).await.is_none());
    }

    #[tokio::test]
    async fn a_request_with_an_older_source_leaves_the_new_one_alone() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(TileCache::default());
        let (old, new) = (source_dir("old"), source_dir("new"));
        cache.put(dir.path(), at(&old, 1), (1, 0, 0), image(50), Format::Png, 0, 1 << 20).await;
        cache.put(dir.path(), at(&new, 2), (1, 0, 0), image(60), Format::Png, 0, 1 << 20).await;
        assert!(!dir.path().join(DIR).join(&old).exists(), "the new source removed the old one's folder");
        // A request that read the setting before the change: no hit, no write, nothing deleted.
        assert!(cache.get(dir.path(), at(&old, 1), (1, 0, 0), 0, 60_000).await.is_none());
        cache.put(dir.path(), at(&old, 1), (2, 0, 0), image(70), Format::Png, 0, 1 << 20).await;
        assert!(!dir.path().join(DIR).join(&old).exists());
        assert_eq!(cache.usage(dir.path(), at(&new, 2)).await, Usage { bytes: 60, tiles: 1 });
    }

    #[tokio::test]
    async fn two_writes_of_one_image_use_parts_of_their_own() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(TileCache::default());
        let source = source_dir("a");
        let writes =
            (0..8).map(|_| cache.put(dir.path(), at(&source, 0), (3, 1, 1), image(300), Format::Png, 0, 1 << 20));
        futures_util::future::join_all(writes).await;
        let files: Vec<_> = std::fs::read_dir(dir.path().join(DIR).join(&source).join("3").join("1"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(files, ["1.png"], "no part file is left behind");
        assert_eq!(cache.usage(dir.path(), at(&source, 0)).await, Usage { bytes: 300, tiles: 1 });
    }

    #[tokio::test]
    async fn images_expire_and_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let cache = Arc::new(TileCache::default());
        let source = source_dir("a");
        cache.put(dir.path(), at(&source, 0), (1, 1, 1), image(100), Format::Png, 10_000, 1 << 20).await;
        let (bytes, format) = cache.get(dir.path(), at(&source, 0), (1, 1, 1), 10_500, 1_000).await.unwrap();
        assert_eq!((bytes.len(), format), (100, Format::Png));
        assert!(cache.get(dir.path(), at(&source, 0), (1, 1, 1), 11_000, 1_000).await.is_none(), "as old as the limit");
        assert_eq!(cache.usage(dir.path(), at(&source, 0)).await, Usage::default());

        // A new process reads the folder; the age is the file's.
        cache.put(dir.path(), at(&source, 0), (2, 1, 0), image(64), Format::Png, 0, 1 << 20).await;
        let restarted = Arc::new(TileCache::default());
        assert_eq!(restarted.usage(dir.path(), at(&source, 0)).await, Usage { bytes: 64, tiles: 1 });

        // Another source starts empty and removes the old one's files.
        let other = source_dir("b");
        assert_eq!(restarted.usage(dir.path(), at(&other, 1)).await, Usage::default());
        assert!(!dir.path().join(DIR).join(&source).exists());

        restarted.put(dir.path(), at(&other, 1), (0, 0, 0), image(10), Format::Png, 0, 1 << 20).await;
        restarted.clear(dir.path()).await;
        assert!(!dir.path().join(DIR).exists());
        assert_eq!(restarted.usage(dir.path(), at(&other, 1)).await, Usage::default());
    }
}
