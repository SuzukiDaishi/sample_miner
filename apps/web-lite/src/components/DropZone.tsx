import { useCallback, useRef, useState } from "react";
import { loadFile } from "../state/actions";

export function DropZone({ compact }: { compact?: boolean }) {
  const [dragover, setDragover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragover(false);
    const file = e.dataTransfer.files[0];
    if (file) void loadFile(file);
  }, []);

  const onPick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void loadFile(file);
    e.target.value = "";
  }, []);

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept="audio/*,.wav,.mp3,.flac,.m4a,.ogg,.webm"
      style={{ display: "none" }}
      onChange={onPick}
    />
  );

  if (compact) {
    return (
      <>
        {input}
        <button onClick={() => inputRef.current?.click()}>Open Audio…</button>
      </>
    );
  }

  return (
    <div
      className={`dropzone-full${dragover ? " dragover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragover(true);
      }}
      onDragLeave={() => setDragover(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
    >
      {input}
      <div className="big">音声ファイルをドロップ / クリックで選択</div>
      <div>wav / mp3 / flac / m4a / ogg / webm</div>
      <div>読み込み後、自動で onset 検出 → チョップ → 分類します</div>
    </div>
  );
}
