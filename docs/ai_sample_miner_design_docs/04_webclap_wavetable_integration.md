# 04. `z-audio-webclap-wavetable` 連携設計

## 既存シンセの位置づけ

既存の `z-audio-webclap-wavetable` は、このプロジェクトの **wavetable素材の出口** として使える。

つまり、

```text
録音/音楽/環境音
  ↓
Sample Miner
  ↓
wavetable抽出
  ↓
z-audio-webclap-wavetable にロード
  ↓
Web上で即試奏
```

ができる。

## 確認した既存構造

対象リポジトリ:

```text
https://github.com/SuzukiDaishi/z-audio-dsp-plugin/tree/main/crates/z-audio-webclap-wavetable
```

### Cargo.toml上の性格

crateは、Serum-inspired wavetable synthesizerとして説明されている。

主な機能:

- 2 wavetable oscillators
- SVF filter
- 2 envelopes
- 2 LFOs
- modulation matrix
- WebCLAP plugin
- `cdylib` + `rlib`

### public modules

```rust
pub mod engine;
pub mod params;
pub mod protocol;
pub mod wavetable;
```

この構造はかなり良い。  
Sample Miner側から見ると、`wavetable` と `engine` を将来native版と共有できる。

## 既存wavetable構造

既存 `wavetable.rs` はfactory wavetableを持つ。

```rust
pub const FRAME_LEN: usize = 2048;
pub const FRAMES: usize = 8;
pub const MIPS: usize = 11;
pub const MAX_HARMONICS: usize = FRAME_LEN / 2;
pub const TABLE_COUNT: usize = 4;
```

この仕様は、録音由来wavetableにもそのまま使いやすい。

### 再生側

`Wavetable::sample()` は3軸補間。

```text
phase
wt_pos
mip level
```

この構造はimported wavetableでもそのまま使える。

### 重要点

既存設計では、mip levelがalias-free playbackの核になっている。  
そのため、録音由来wavetableでも必ずmipを生成する必要がある。

## 改造方針

現在はfactory wavetable専用。  
これを以下に拡張する。

```text
factory tables
  +
imported/generated tables
```

## 追加したい型

```rust
pub enum WavetableOrigin {
    Factory,
    Imported,
    GeneratedFromAudio,
}

pub struct WavetableMeta {
    pub name: String,
    pub origin: WavetableOrigin,
    pub root_note: Option<u8>,
    pub source_asset_id: Option<String>,
}
```

`WavetableSet` を拡張する。

```rust
pub struct WavetableSet {
    tables: Vec<Wavetable>,
    metas: Vec<WavetableMeta>,
}
```

## `Wavetable::from_audio_frames()`

録音由来wavetableを作る関数。

```rust
impl Wavetable {
    pub fn from_audio_frames(
        frames: &[f32],
        frame_count: usize,
        frame_len: usize,
    ) -> Result<Self, WavetableError> {
        // 1. frame_countをFRAMESへ正規化
        // 2. 各frameをFRAME_LENへresample
        // 3. DC除去
        // 4. phase align
        // 5. mip生成
        // 6. normalize
        todo!()
    }
}
```

## imported wavetableのmip生成

factory tableはharmonic recipeから加算合成してmipを作っている。  
imported tableはFFTで高域を削る。

```text
input frame
  ↓
FFT
  ↓
mipごとにmax harmonicを決める
  ↓
高域binをzero
  ↓
IFFT
  ↓
normalize
```

擬似コード:

```rust
fn render_imported_mips(frame: &[f32], data: &mut [f32], frame_index: usize) {
    for mip in 0..MIPS {
        let max_harmonic = MAX_HARMONICS >> mip;
        let filtered = fft_lowpass_harmonics(frame, max_harmonic);
        write_frame_mip(data, frame_index, mip, &filtered);
    }
}
```

## protocol拡張

既存protocolには、UI → plugin のwavetableロードpacketがない。

追加する。

```rust
pub const MAGIC_LOAD_TABLE: &[u8; 4] = b"ZWTL";
```

### `ZWTL` packet案

```text
magic:      4 bytes  "ZWTL"
slot:       u8
frameCount: u8
frameLen:   u16
rootNote:   u8
reserved:   u8 * 3
samples:    frameCount * frameLen * f32 little endian
```

8 frames × 2048 samples × f32 = 65,536 bytes。  
最初は1 packetで問題なさそう。

将来的にpayload制限があればchunk化。

```text
ZWTH: header
ZWTF: frame chunk
ZWTE: end
```

## parse関数

```rust
pub struct LoadTablePacket {
    pub slot: u8,
    pub frame_count: u8,
    pub frame_len: u16,
    pub root_note: u8,
    pub samples: Vec<f32>,
}

pub fn parse_load_table(bytes: &[u8]) -> Option<LoadTablePacket> {
    if bytes.len() < 12 || &bytes[..4] != b"ZWTL" {
        return None;
    }

    let slot = bytes[4];
    let frame_count = bytes[5];
    let frame_len = u16::from_le_bytes([bytes[6], bytes[7]]);
    let root_note = bytes[8];

    let sample_count = frame_count as usize * frame_len as usize;
    let expected = 12 + sample_count * 4;
    if bytes.len() != expected {
        return None;
    }

    let mut samples = Vec::with_capacity(sample_count);
    let mut offset = 12;
    for _ in 0..sample_count {
        samples.push(f32::from_le_bytes(bytes[offset..offset + 4].try_into().ok()?));
        offset += 4;
    }

    Some(LoadTablePacket {
        slot,
        frame_count,
        frame_len,
        root_note,
        samples,
    })
}
```

## `on_ui_message()` 拡張

現在は、

- `ready`
- note preview

を処理している。

ここにwavetable loadを追加する。

```rust
fn on_ui_message(&mut self, bytes: &[u8]) -> bool {
    if bytes == b"\x65ready" {
        self.ui_seen = true;
        self.push_stacks();
        self.push_previews();
        return true;
    }

    if let Some(packet) = parse_load_table(bytes) {
        if self.engine.load_wavetable(packet).is_ok() {
            self.push_stacks();
            self.push_previews();
        }
        return true;
    }

    if let Some((on, key, velocity)) = parse_note_preview(bytes) {
        if on {
            self.engine.note_on(key, velocity as f32 / 127.0);
        } else {
            self.engine.note_off(key);
        }
        return true;
    }

    false
}
```

## engine側API

```rust
impl SynthEngine {
    pub fn load_wavetable(
        &mut self,
        slot: usize,
        frames: &[f32],
        frame_count: usize,
        frame_len: usize,
        root_note: Option<u8>,
    ) -> Result<(), WavetableError> {
        self.wavetables.load_imported(
            slot,
            frames,
            frame_count,
            frame_len,
            root_note,
        )
    }
}
```

## params拡張

現在 `OSC_TABLE` は `TABLE_COUNT - 1` を最大値にしている。  
imported tableを扱うなら、ここを動的または固定最大数にする。

簡単な方針:

```rust
pub const MAX_TABLES: usize = 32;
```

factory 4 + imported最大28。

```rust
OSC_TABLE max = MAX_TABLES - 1
```

## Sample Miner側の送信形式

Web Lite側で以下を作る。

```ts
type ExtractedWavetable = {
  slot: number;
  rootNote: number;
  frameCount: 8;
  frameLen: 2048;
  samples: Float32Array;
};
```

送信:

```ts
function encodeLoadTablePacket(wt: ExtractedWavetable): Uint8Array {
  const headerSize = 12;
  const sampleBytes = wt.samples.length * 4;
  const bytes = new Uint8Array(headerSize + sampleBytes);
  const view = new DataView(bytes.buffer);

  bytes[0] = "Z".charCodeAt(0);
  bytes[1] = "W".charCodeAt(0);
  bytes[2] = "T".charCodeAt(0);
  bytes[3] = "L".charCodeAt(0);

  view.setUint8(4, wt.slot);
  view.setUint8(5, wt.frameCount);
  view.setUint16(6, wt.frameLen, true);
  view.setUint8(8, wt.rootNote);

  let offset = 12;
  for (const s of wt.samples) {
    view.setFloat32(offset, s, true);
    offset += 4;
  }

  return bytes;
}
```

## 既存UIとの接続

既存WebCLAP synth側は以下のpreview packetを持つ。

- waveform preview
- meter
- wavetable stack
- note preview

imported tableロード後に、

```rust
self.push_stacks();
self.push_previews();
```

すれば既存preview UIに反映できる。

## 最短MVP

最短で作るべき統合はこれ。

```text
1. Web Liteで音声を読み込む
2. 手動region選択
3. f0推定
4. 8 frame wavetable抽出
5. ZWTL packetを作る
6. WebCLAP synthへ送信
7. キーボードで鳴らす
```

この時点では、onset自動検出もAI分離も不要。

## 次の拡張

- 自動pitch stable region検出
- 複数wavetable候補ランキング
- imported tableの保存
- `.zwt` export
- factory/imported table browser
- root note補正
- wavetable morph preview
- imported tableをOSC A/Bへ自動割当
- drone/pad用プリセット自動設定

## プリセット自動設定

### 普通に弾く

```text
OSC A:
  table = imported
  wt_pos = 0.0
  unison = 1
  rand_phase = 0.0

Env1:
  attack = 0.005
  decay = 0.2
  sustain = 0.8
  release = 0.15

Filter:
  cutoff = 20000
```

### Pad / Drone化

```text
OSC A:
  table = imported
  wt_pos = 0.3
  unison = 4
  detune = 0.15
  blend = 0.8

Env1:
  attack = 1.0
  decay = 2.0
  sustain = 0.9
  release = 3.0

LFO1 → A WT Pos:
  rate = 0.1〜0.3Hz
  amount = 0.2
```
