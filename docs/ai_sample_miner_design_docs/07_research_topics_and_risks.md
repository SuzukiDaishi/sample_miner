# 07. 研究テーマ・技術リスク

## 1. チョップ品質

このツールで最も体験に効くのは、実はAI分類よりチョップ品質。

課題:

- attackを欠かない
- onsetが遅れない
- クリックしない
- tailを切りすぎない
- 余白を残しすぎない
- 複数音が重なったときに破綻しない

研究テーマ:

- onset backtracking
- adaptive threshold
- transient-aware slicing
- tail energy estimation
- zero crossing correction
- micro fade最適化

## 2. wavetable候補判定

なんでもwavetableにすると汚い。

良い候補条件:

```text
pitch confidence 高い
pitch stability 高い
periodicity 高い
noise少なめ
attack直後ではない
音量が安定
単音性が高い
```

課題:

- pitchが揺れる声からどう作るか
- noisyな素材から面白いwavetableを作るか
- phase alignment
- frame間の位相連続性
- mip生成
- alias対策
- root note推定

## 3. imported wavetableのmip生成

既存WebCLAP synthはmipによるalias-free playbackが前提。  
imported wavetableでもmipを作らないと高音でaliasが出る。

研究テーマ:

- FFT lowpass mip
- harmonic-domain truncation
- minimum phase化の是非
- frameごとのnormalize
- mip間のloudness consistency
- high note playback品質

## 4. drone loop品質

ドローンは継ぎ目が命。

課題:

- start/endのスペクトル差
- RMS差
- 位相差
- textureの周期感
- crossfadeで発生するフラム
- rhythmic materialのloop違和感

研究テーマ:

- MFCC similarity
- chroma similarity
- waveform endpoint distance
- transient penalty
- crossfade length search
- beat-aligned loop
- texture-aware loop scoring

## 5. 分離AIの限界

Demucs / AudioSep等を使っても完璧には分離できない。

問題:

- musical bleed
- artifact
- phasey sound
- transientのにじみ
- drumとnoiseの誤分離
- vocalsの残響
- 環境音queryの不安定さ

方針:

- 分離結果だけでなくoriginalも残す
- stemを複数候補として扱う
- ユーザーが採用/不採用を選べるUIにする
- 分離artifactも素材として使える可能性を残す

## 6. AI分類の誤判定

CLAP / YAMNet / PANNs等はタグ付けには便利だが、最終判断には危険。

方針:

```text
rule-based大分類
  +
AI tag候補
  +
ユーザー修正
```

AIの使い方:

- 決定ではなく候補提示
- confidenceを表示
- 複数タグを表示
- ユーザー修正を保存
- 後で閾値調整に使う

## 7. MIDI化の精度

Basic Pitch等でphraseをMIDI化できるが、素材によっては精度が悪い。

課題:

- polyphonic material
- noisy material
- pitch bend
- attackless sound
- ambient tone
- vocal formant

方針:

- MIDIはoptional output
- confidenceを付ける
- previewできるようにする
- quantize before/afterを選べるようにする

## 8. Web Liteの制約

ブラウザ版の制約:

- メモリ制限
- 長尺ファイルが重い
- Web Audio decodeの挙動差
- Worker転送コスト
- WASM buildの複雑さ
- AIモデルが載せにくい

対策:

- 解析用downsample
- 長尺はchunk処理
- AudioBuffer全体コピーを避ける
- WorkerにTransferableを使う
- 最初は手動region中心でよい

## 9. Full版の配布リスク

クライアントPC版は、モデル配布が重い。

課題:

- Python同梱
- torch / CUDA / Metal
- モデルサイズ
- Windows/macOS/Linux差分
- GPU有無
- ONNX変換
- ライセンス

方針:

- 最初はdeveloper toolとしてPython backendでよい
- 製品化時にONNX Runtime化を検討
- CPU fallbackを用意
- モデルは初回download方式も検討
- full installerとlite installerを分ける

## 10. ライセンス・権利

### ライブラリ/モデル

注意が必要なもの:

- Rubber Band: GPLまたは商用ライセンスが必要
- AIモデル: モデル重みのライセンスを個別確認
- pretrained dataset由来の制約
- ffmpeg配布形態
- WebCLAP / plugin SDK周り

### 入力音源の権利

ツールとして特に注意。

問題:

- 既存楽曲を分離して素材化する行為
- ボーカル抽出
- one-shot化して再利用
- 商用曲からwavetable化
- third-party sample packの再加工

方針:

- UIに「自分の録音または使用権のある素材向け」と明記
- export時に注意表示
- cloud backendの場合は利用規約が必要
- local-firstのほうが安全

## 11. 研究価値が高い領域

このプロジェクトで自作価値が高い部分。

### A. 録音由来wavetable生成

- pitch stable region detection
- robust cycle extraction
- phase alignment
- multi-frame morph
- mip generation
- quality score

### B. 素材分類UX

- AIタグ + ルール + ユーザー修正
- sample grid UI
- confidence表示
- 類似素材のクラスタリング

### C. drone loop maker

- high quality loop point search
- texture-specific crossfade
- scoring
- realtime preview

### D. WebCLAP統合

- generated wavetableを即シンセで鳴らす
- Web版とnative版のengine共有
- imported table protocol
- DAW連携

## 12. 重要な設計原則

最後に、プロジェクト全体の設計原則。

```text
AIを主役にしすぎない
  → 最初は音素材採掘ツールとして作る

分類は間違う前提
  → ユーザー修正UIを重視

出力manifestを共通化
  → Lite/Full/nativeをつなぐ

WebCLAP synthを出口にする
  → 録音→wavetable→即試奏の体験を作る

分離AIは後から足す
  → 最初はチョップとwavetable化のUXを固める
```
