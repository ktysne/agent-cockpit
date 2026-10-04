'use strict';

// 時刻を固定し、明示した呼び出しでだけ進める Date を作る。
// 引数なしの new Date() と Date.now() が固定値を返し、解析や整形は本物の Date に任せる。
function createFakeClock(RealDate, initialMilliseconds) {
  if (!Number.isFinite(initialMilliseconds)) throw new Error('時計の初期値が不正です');
  let current = initialMilliseconds;
  let follow = null;
  const read = () => (follow ? follow.from + (follow.monotonic() - follow.startedAt) : current);

  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(read());
      else super(...args);
    }

    static now() {
      return read();
    }
  }

  const clock = {
    now: read,
    set(milliseconds) {
      if (follow) throw new Error('実時間に合わせて進めている時計は手で動かせません');
      if (!Number.isFinite(milliseconds)) throw new Error('時計の値が不正です');
      if (milliseconds < current) throw new Error('時計は戻せません');
      current = milliseconds;
    },
    advance(milliseconds) {
      clock.set(current + milliseconds);
    },
    // 今の値から実時間の経過だけ進める。壁時計ではなく単調な時間を使い、OS の時刻合わせで戻らないようにする。
    followRealTime(monotonic = () => performance.now()) {
      if (follow) return;
      follow = { from: current, startedAt: monotonic(), monotonic };
    },
  };
  return { FakeDate, clock };
}

let installed = null;

// サーバーのモジュールを読み込む前に呼ぶ。入れ替えは 1 つだけで、戻すときは clock.uninstall() を呼ぶ。
// 同じプロセスで動く他のテストの時計を狂わせないため、入れたままにしない。
function installFakeClock(initialMilliseconds) {
  if (installed) throw new Error('固定した時計がすでに入っています');
  const RealDate = globalThis.Date;
  const { FakeDate, clock } = createFakeClock(RealDate, initialMilliseconds);
  globalThis.Date = FakeDate;
  installed = clock;
  clock.uninstall = () => {
    if (installed !== clock) return;
    globalThis.Date = RealDate;
    installed = null;
  };
  return clock;
}

module.exports = { createFakeClock, installFakeClock };
