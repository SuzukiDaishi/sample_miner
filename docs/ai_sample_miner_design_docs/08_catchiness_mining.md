# 08. キャッチーな音の採掘 (Catchiness Mining)

## 1. 課題

現状のキュレーション (`apps/backend/app/pipeline/curate.py`) は
**技術品質**でしか素材を選んでいない。

```text
one-shot : 減衰完結 / attack速度 / 単発性 / クリップ無し / 長さ
phrase   : 頭とお尻の無音着地 / 長さ / クリップ無し
riff     : 音量 + ループ継ぎ目の滑らかさ
```

これらは「壊れていない素材」を保証するが、「使いたくなる素材」を保証しない。
実際に起きること:

- 技術的に完璧だが地味なパッド音が、曲のフックになっている印象的な音を押しのけて採用される
- 曲中で一番繰り返される(=一番キャッチーな)フレーズと、間奏の埋め草フレーズが同じスコアになる
- CATEGORY_CAPS の上位枠が「綺麗なだけの音」で埋まる

## 2. キャッチーさの操作的定義

「キャッチー」は主観だが、素材採掘の文脈では測定可能な代理指標に分解できる。

| 軸 | 意味 | 代理指標 |
|---|---|---|
| salience | 耳を引く。抜けが良い | presence帯域 (2–5kHz) エネルギー比、crest factor、attack鋭さ |
| hookiness | 曲中で繰り返される。作者が推している音 | 原曲 self-similarity 上の反復回数 |
| distinctiveness | その曲の中で目立つ。他と違う | segment と曲全体平均のスペクトル距離 |
| memorability | 音色・動きに特徴がある | pitch 動き量、スペクトル変化量 (単調すぎず暴れすぎず) |
| production | そもそも音が良い | 既存の技術品質スコア |

重要な設計判断: **技術品質とキャッチーさは直交する 2 軸として持つ**。
「技術品質 = 足切り、キャッチーさ = ランキング」と役割を分ける。
最終スコアで混ぜて 1 軸にすると、どちらの失敗かデバッグできなくなる。

```text
最終選定 = 技術品質が閾値以上のものを、キャッチーさ順に CATEGORY_CAPS まで採用
score    = quality_gate(q) ? catchiness : 0
```

## 3. 4 層のスコアリング構成

コストと信頼性が違う 4 層を段階導入する。上の層ほど安くて確実。

```text
Layer A: DSP 代理特徴          追加依存なし。librosa のみ。まずここ
Layer B: 反復検出 (hook 検出)   librosa のみ。原曲の self-similarity
Layer C: CLAP 対照プロンプト     既存 CLAP を流用。弱いシグナルとして加点
Layer D: 学習ベース美的評価      Audiobox-Aesthetics / ユーザーfeedback。後回し
```

### 3.1 Layer A: DSP 代理特徴 (Phase C1)

`features.py::compute_features` に追加する。全て既存の計算バッファを流用でき、
コスト増はほぼゼロ。

```python
# presence 帯域比: 2–5kHz は「抜け」の帯域。ミックスで前に出る音はここが強い
presence_ratio = spec[(freqs >= 2000) & (freqs <= 5000)].sum() / total

# crest factor: peak/RMS 比。パンチのある音は大きい (dB差 8〜20 が目安)
crest_db = peak_db - rms_db

# スペクトル変化量: 音色が動く音は記憶に残る。ただし動きすぎはノイズ
spectral_flux_mean = onset_strength(y).mean()

# pitch 動き量: メロディ素材向け。半音単位の動きがある = フレーズとして立つ
pitch_range_semitones = (f0_max - f0_min) の半音換算  # voiced 区間のみ
```

カテゴリ別のキャッチーさ合成 (`curate.py` に `catchiness_*()` を追加):

```text
drums   : 0.4*crest + 0.3*presence + 0.3*attack鋭さ
bass    : 0.4*低域の太さ(<150Hz比) + 0.3*crest + 0.3*f0安定
melodic : 0.3*presence + 0.3*pitch明瞭(f0Confidence) + 0.2*倍音豊かさ(1-flatness) + 0.2*crest
vocal   : 0.4*presence + 0.3*pitch動き量 + 0.3*voicedRatio
riff    : Layer B の hook スコアを主軸 (下記)
```

**注意: loudness をキャッチーさに入れない。**
「大きい音 = キャッチー」に必ず退化する。スコアリング前に -1dBFS ピーク
正規化した状態 (export_wav と同条件) で特徴を測る。RMS/peak は品質足切り
(音量不足除外) にのみ使う。

### 3.2 Layer B: 反復検出 = hook 検出 (Phase C1)

**曲のフックは繰り返される**。作者が一番聴かせたい音は曲中に何度も出てくる。
これは主観に依存しない、最も信頼できるキャッチーさシグナル。

原曲 (Original トラック) 全体で chroma self-similarity を取り、
各 segment が「曲中の反復領域」にどれだけ重なるかを測る:

```text
1. 原曲の beat-synchronous chroma + MFCC を計算
2. self-similarity matrix S を作る (cosine)
3. 対角線ストライプ検出で反復ペア区間を列挙
   (librosa.segment.recurrence_matrix + 時間ラグ表現で十分。外部依存不要)
4. 時間軸上の「反復回数マップ」 repeat_count(t) を作る
5. segment/riff のスコア = その区間の repeat_count 平均を 0..1 正規化
```

- `extract_other_riffs` の候補スコアに `0.4 * hook_score` を加える。
  現状の「音量 + 継ぎ目」だけだと、イントロの伴奏とサビのリフが区別できない。
  hook_score を入れると **サビ・フックのリフが自然に上位へ来る**
- vocal phrase にも同じマップを適用 (サビの vocal chop が上位に来る)
- one-shot には適用しない (kick は全編鳴っているので無意味)

計算は曲 1 本につき 1 回。beat-synchronous にすれば行列は高々数百 × 数百で軽い。

### 3.3 Layer C: CLAP 対照プロンプト (Phase C2)

CLAP (`clap_worker.py`) は既にパイプラインに居る。テキスト埋め込みは起動時
1 回で済むので、プロンプトを足すコストはほぼゼロ。

分類用の中立プロンプトとは別に、**対照ペア**で美的スコアを取る:

```python
CATCHY_PROMPT_PAIRS = [
    ("a catchy punchy drum hit",        "a weak muffled drum hit"),
    ("a memorable melodic hook",        "boring background music"),
    ("a fat powerful bass sound",       "a thin weak bass sound"),
    ("an expressive vocal phrase",      "a dull monotone voice"),
    ("a bright clear musical sound",    "a muddy unclear sound"),
]
# score = sigmoid(sim(audio, positive) - sim(audio, negative))
```

単発プロンプトの類似度は絶対値が不安定だが、**ペアの差分**を取ると
録音条件のバイアスが打ち消されて実用になる (zero-shot preference の定石)。

制約と扱い:

- CLAP は美的評価用に学習されていない → **弱いシグナル。重み 0.1〜0.2 に留める**
- docs 07 §6 の方針通り「AI は決定に使わない」を維持。
  catchiness への加点であって、分類やカテゴリ決定には使わない
- `MAX_CLAP_SEGMENTS` の選び方を「長い順」から
  「Layer A/B スコア上位順」へ変える (キャッチー候補にこそタグとスコアを付ける)

### 3.4 Layer D: 学習ベース (Phase C3, optional)

2 方向あり、どちらも Layer A–C の効果を見てから判断する。

**D-1: 既製の美的評価モデル**

- Meta **Audiobox-Aesthetics**: 音声の Content Enjoyment (CE) /
  Production Quality (PQ) / Production Complexity (PC) / Content Usefulness (CU)
  を予測する公開モデル。CE+PQ がキャッチーさの代理として使える
- 単一モデル・推論のみで導入できるが、依存が増える。
  `model_availability()` に足して optional 扱いにする (Demucs 等と同じ方針)

**D-2: ユーザー個人化 (feedback ranker)**

- Web Lite の asset browser に keep / discard ボタンを付け、判定を
  manifest 拡張 (`userRating`) として蓄積
- CLAP audio embedding (既に計算している) を特徴量に、
  logistic regression / 小さな ranker を学習
- 「その人にとってのキャッチー」に寄せられる。データが数百件貯まってから

## 4. パイプラインへの統合

### 4.1 変更ファイル

```text
features.py  : presenceRatio / crestDb / spectralFluxMean / pitchRangeSemitones を追加
runner.py    : 原曲の repeat_count マップを 1 回計算し、各 segment features に
               hookScore として付与。CLAP 対象選定を catchiness 上位順へ
curate.py    : quality (足切り) と catchiness (ランキング) を分離。
               Curated に catchiness / quality フィールド追加。
               CATEGORY_CAPS の選定を catchiness 順に変更
clap_worker.py: CATCHY_PROMPT_PAIRS と score_catchy() を追加
schema (docs 05): AudioFeatures に hookScore 等を additive に追加 (v0.1 のまま)
```

### 4.2 選定ロジックの変更 (curate.py)

```python
# before: score 1軸でソートして cap
group = sorted(..., key=lambda r: -r.score)

# after: 品質は gate、キャッチーさで順位付け
group = [r for r in results if r.quality >= QUALITY_GATE[cat]]
group.sort(key=lambda r: -r.catchiness)
```

reasons にキャッチーさの根拠も残す (「サビで4回反復」「presence強い」など)。
UI 側で「なぜこれが選ばれたか」が見えることが、スコアの調整・信頼に効く。

### 4.3 Web Lite への波及

- Web Lite (DSP only) でも Layer A はそのまま移植可能 (analysis.worker.ts)
- Layer B は曲全体解析が要るので backend 優先。Web Lite は Phase C2 以降
- asset browser に catchiness ソート + 理由表示を追加

## 5. 段階導入ロードマップ

| Phase | 内容 | 依存追加 | 期待効果 | 状況 |
|---|---|---|---|---|
| C1 | Layer A (DSP代理) + Layer B (hook検出) + curate 2軸化 | なし | riff/vocal がサビ由来になる。抜けの良い one-shot が上位に | **実装済 (backend)**: `features.py` に presenceRatio / crestDb / spectralFluxMean / pitchRangeSemitones、`hooks.py` に反復マップ、`curate.py` を quality/catchiness 2軸化 |
| C2 | Layer C (CLAP対照ペア) + CLAP対象選定の変更 + Web Lite へ Layer A 移植 | なし (既存CLAP) | 音色の良し悪しが弱く反映される | **実装済**: `clap_worker.py` に CATCHY_PROMPT_PAIRS + `analyze_audio()` (1 embedding で tags と catchy を両取り)、CLAP 対象を catchiness 上位順に、`clapCatchy` を weight 0.15 で blend。Web Lite は features/catchiness 移植 + SliceGrid をキャッチーさ順ソート |
| C3 | Layer D (Audiobox-Aesthetics or feedback ranker) | あり | 汎用/個人化された美的評価 | **実装済**: D-1 `aesthetics_worker` (CE+PQ 正規化 → aesScore, weight 0.15, optional 依存)。D-2 keep/discard `userRating` (Web Lite Inspector + backend rating API) → `scripts/train_ranker.py` (CLAP embedding 上の numpy ロジスティック回帰) → personalScore (weight 0.2) |

C1 だけでも体感が変わるはず。**hook 検出が本命**で、DSP 代理はその補強。

## 6. 評価方法

主観指標なので、導入時に必ず A/B で確かめる:

1. 手持ちの数曲で「自分ならこの 5 個を選ぶ」を先に手動マークしておく
2. 旧スコア / 新スコアそれぞれの上位選定と突き合わせて precision@k を比較
3. reasons を見て「なぜ上がった/下がった」が説明できるか確認
4. ジャンル違い (EDM / アコースティック / フィールドレコーディング) で退行がないか

## 7. リスク

- **主観性**: 万人のキャッチーは存在しない → 代理指標 + reasons 表示 + 個人化 (D-2) で逃がす
- **loudness 退化**: 正規化後に測る (§3.1)。テストで「無音寄りだが反復の多い素材」が拾えるか確認
- **ジャンル依存**: presence 偏重は EDM に寄る。カテゴリ別の重みを config 化しておく
- **CLAP の過信**: 重みを小さく固定。決定には使わない (docs 07 §6 の方針を維持)
- **hook 検出の失敗モード**: ループ主体の曲 (全編反復) では差が付かない →
  repeat_count の分散が小さい曲では hook 重みを自動的に下げる
