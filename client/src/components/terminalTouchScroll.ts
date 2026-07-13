import type { Terminal } from '@xterm/xterm';

// タップとドラッグを区別する閾値(px)。これ未満の指の移動はタップとみなし、
// xterm(=タップ→tmuxのクリック)へそのまま素通しする。
const DRAG_START_THRESHOLD_PX = 8;

// 1行分の画面高を取得できない場合のフォールバック(px)。
const MIN_PIXELS_PER_LINE = 16;

interface Gesture {
  /** この操作を追跡している指のTouch.identifier。 */
  id: number;
  /** touchstart時のY座標。閾値判定の基準。 */
  startY: number;
  /** ノッチ計測の基準Y。ノッチを送るたびに前進させる。 */
  anchorY: number;
  /** 1ノッチ(=1行スクロール)に対応する指の移動量(px)。ドラッグ確定時に確定する。 */
  pixelsPerNotch: number;
  /** タップ超えのドラッグに移行済みか。 */
  dragging: boolean;
  /** ドラッグ確定時に固定した、ホイールイベントを載せる画面内の安全な座標。 */
  clientX: number;
  clientY: number;
}

/**
 * スマホのタッチ操作でターミナルの履歴を指でスクロールできるようにする。
 *
 * 背景: このアプリのターミナルはtmux(mouse on)にアタッチしている。tmuxは代替スクリーンを
 * 使うためxterm.js自身のスクロールバックは常に空で、履歴のスクロールはすべてtmuxのコピーモード
 * 経由になる。PCではマウスホイールがxterm→tmuxのマウス報告に変換されコピーモードがスクロール
 * するが、iOS Safari等のタッチにはホイールが無く、xterm v6も指スクロールをビューポートへ配線
 * していないため、スマホでは履歴をたどれない。
 *
 * そこで縦方向の指ドラッグを検知し、xterm.jsのホイール処理(coreMouseService)へ合成WheelEventを
 * 流し込む。マウス報告のエスケープシーケンス(交渉済みのSGR等のプロトコル)の組み立てはxterm側に
 * 任せられるため自前で実装する必要がなく、PCのホイールと同一経路でtmuxのコピーモードを
 * スクロールできる。
 *
 * スクロールの粒度(「一度に何行も動く」対策): 合成WheelEventは「1行分(DOM_DELTA_LINE,
 * deltaY=±1)」で送り、これを受けたtmuxコピーモードが1ノッチ=1行だけ動くよう server/tmux.conf の
 * WheelUp/DownPaneバインドを設定している(既定は1ノッチ=5行)。さらに、指が「実際に見えている
 * 1行の高さ」だけ動くごとに1ノッチ送るため、指の動きにほぼ1:1で画面が追従する
 * (色付きテキストを指でなぞってスクロールする感覚)。
 *
 * @param term  対象のxterm.js Terminal(open()済みであること)
 * @param container タッチイベントを購読する要素(term.elementを内包する)
 * @returns 後始末用のクリーンアップ関数(リスナー解除)
 */
export function enableTerminalTouchScroll(term: Terminal, container: HTMLElement): () => void {
  const root = term.element;
  // xtermがホイールイベントの座標をこの要素の矩形基準で解釈するため、要素外の座標だと報告が破棄される。
  const screen = root?.querySelector<HTMLElement>('.xterm-screen') ?? null;
  if (!root || !screen) return () => {};

  let gesture: Gesture | null = null;

  function findTouch(list: TouchList, id: number): Touch | null {
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === id) return list[i];
    }
    return null;
  }

  // 画面に見えている1行分のピクセル高。指の移動量→スクロール行数の換算に使う。
  function pixelsPerLine(): number {
    const rows = term.rows || 1;
    return Math.max(MIN_PIXELS_PER_LINE, screen!.getBoundingClientRect().height / rows);
  }

  // 1ノッチ分スクロールさせる。scrollUp=trueで上(古い履歴)、falseで下(新しい履歴)。
  function scrollByNotch(scrollUp: boolean, clientX: number, clientY: number) {
    // マウス報告モードでは1イベント=1ノッチで、大きさより符号が重要。DOM_DELTA_LINEの±1を使うと
    // セル高・DPRに依存せず確実に1ノッチとして扱われる(pixelモードの端数蓄積で無効化されない)。
    root!.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: scrollUp ? -1 : 1,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  function onTouchStart(e: TouchEvent) {
    // マルチタッチ(ピンチ等)はスクロール対象外。ブラウザ/xtermの既定動作に委ねる。
    if (e.touches.length !== 1) {
      gesture = null;
      return;
    }
    const t = e.touches[0];
    gesture = {
      id: t.identifier,
      startY: t.clientY,
      anchorY: t.clientY,
      pixelsPerNotch: MIN_PIXELS_PER_LINE,
      dragging: false,
      clientX: 0,
      clientY: 0,
    };
  }

  function onTouchMove(e: TouchEvent) {
    if (!gesture) return;
    const t = findTouch(e.touches, gesture.id);
    if (!t) return;

    if (!gesture.dragging) {
      if (Math.abs(t.clientY - gesture.startY) < DRAG_START_THRESHOLD_PX) return;
      gesture.dragging = true;
      gesture.anchorY = t.clientY;
      gesture.pixelsPerNotch = pixelsPerLine();
      // ドラッグ確定時点で画面中央の安全な座標を固定し、以降のノッチで使い回す。
      const rect = screen!.getBoundingClientRect();
      gesture.clientX = rect.left + rect.width / 2;
      gesture.clientY = rect.top + rect.height / 2;
    }

    // ドラッグ中はページスクロールと、タッチ→マウス互換イベント(tmuxの誤ドラッグ選択)を抑止する。
    e.preventDefault();

    // 指の移動を蓄積し、1行分たまるごとにホイールノッチを1つ送る。
    // 指を下げる=コンテンツを下へ引っ張る=古い履歴を見る=ホイール上(scrollUp)。
    let dy = t.clientY - gesture.anchorY;
    while (Math.abs(dy) >= gesture.pixelsPerNotch) {
      const movingDown = dy > 0;
      scrollByNotch(movingDown, gesture.clientX, gesture.clientY);
      const advance = movingDown ? gesture.pixelsPerNotch : -gesture.pixelsPerNotch;
      gesture.anchorY += advance;
      dy -= advance;
    }
  }

  function onTouchEnd(e: TouchEvent) {
    if (!gesture) return;
    // 追跡中の指がまだ画面上に残っていれば継続。離れていればジェスチャ終了。
    if (findTouch(e.touches, gesture.id)) return;
    gesture = null;
  }

  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, { passive: false });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchEnd, { passive: true });

  return () => {
    container.removeEventListener('touchstart', onTouchStart);
    container.removeEventListener('touchmove', onTouchMove);
    container.removeEventListener('touchend', onTouchEnd);
    container.removeEventListener('touchcancel', onTouchEnd);
  };
}
