import { useEffect, useState } from "react";
import { apiFetch } from "../apiFetch";

interface Props {
  csrfToken: string;
}

interface SleepGuardResponse {
  enabled?: boolean;
}

// 物理入力の無いセッションはGNOME側にアイドル判定されMutterの描画が間引かれ映像が
// 更新されなくなるため、必要な時だけサーバー側でマウスの微小移動を送り続けさせる
function SleepGuardToggle({ csrfToken }: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    apiFetch("api/display/sleep-guard")
      .then((res) => res.json())
      .then((data: SleepGuardResponse) => setEnabled(Boolean(data.enabled)))
      .catch(() => setError(true));
  }, []);

  async function handleClick() {
    if (enabled === null || pending) return;
    const next = !enabled;
    setPending(true);
    setError(false);
    try {
      const res = await apiFetch("api/display/sleep-guard", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error("request failed");
      const data: SleepGuardResponse = await res.json();
      setEnabled(Boolean(data.enabled));
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      className={`statusbar-btn${enabled ? " statusbar-btn-active" : ""}`}
      onClick={handleClick}
      disabled={enabled === null || pending}
    >
      {error ? "スリープ防止(エラー)" : `スリープ防止: ${enabled ? "ON" : "OFF"}`}
    </button>
  );
}

export default SleepGuardToggle;
