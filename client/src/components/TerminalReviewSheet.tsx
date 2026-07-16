import { useCallback, useEffect, useRef, useState } from "react";
import { AnsiUp } from "ansi_up";

interface TerminalReviewSheetProps {
  id: string;
  onClose: () => void;
}

type LoadState = "loading" | "ready" | "error";

// use_classesで標準16色をクラス出力させApp.css側でxterm既定パレットに合わせる
// ansi_upは既定でHTMLエスケープするため変換結果をそのままDOMへ差し込んでも安全
function ansiToColoredHtml(text: string): string {
  const ansiUp = new AnsiUp();
  ansiUp.use_classes = true;
  return ansiUp.ansi_to_html(text);
}

async function fetchTerminalHistory(id: string): Promise<string> {
  const res = await fetch(`/api/terminal/history/${id}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`history request failed: ${res.status}`);
  return res.text();
}

// canvas描画のxtermでは効かないモバイルの選択・コピーをDOMテキストの別サーフェスで解決する
function TerminalReviewSheet({ id, onClose }: TerminalReviewSheetProps) {
  const [state, setState] = useState<LoadState>("loading");
  const [html, setHtml] = useState("");
  const preRef = useRef<HTMLPreElement | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      setHtml(ansiToColoredHtml(await fetchTerminalHistory(id)));
      setState("ready");
    } catch {
      setState("error");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (state === "ready" && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight; // 最新の出力へ寄せる
    }
  }, [state, html]);

  return (
    <div className="review-sheet">
      <div className="review-sheet-header">
        <span className="review-sheet-title">
          テキスト表示(長押しで選択・コピー)
        </span>
        <button type="button" className="statusbar-btn" onClick={() => void load()}>
          更新
        </button>
        <button type="button" className="statusbar-btn" onClick={onClose}>
          閉じる
        </button>
      </div>
      {state === "loading" && <div className="review-sheet-status">読み込み中…</div>}
      {state === "error" && (
        <div className="review-sheet-status">
          履歴を取得できませんでした(ターミナル未接続の可能性)。
        </div>
      )}
      {state === "ready" && (
        <pre
          ref={preRef}
          className="review-sheet-text"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}

export default TerminalReviewSheet;
