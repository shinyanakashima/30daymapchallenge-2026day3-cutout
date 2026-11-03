// 解析Worker のクライアント。要求ごとに reqId を振り、応答・進捗・エラーを振り分ける。
import type { Msg, Req, Res } from '../worker/protocol';

type Pending = { resolve: (r: Res) => void; reject: (e: Error) => void; onProgress?: (r: Res) => void };

/** Worker からのエラー。msg は画面側で翻訳する */
export class WorkerError extends Error {
  constructor(
    public msg: Msg,
    public stage?: string,
  ) {
    super(msg.k);
  }
}

// 各要求の型から reqId を除いたもの（判別共用体を保つ）
type DistOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type ReqBody = DistOmit<Req, 'reqId'>;

export class AnalysisClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();
  onFatal?: (msg: Msg) => void;

  constructor() {
    this.worker = new Worker(new URL('../worker/analysis.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<Res>) => this.handle(ev.data);
    this.worker.onerror = (ev) => {
      const msg: Msg = { k: 'st.workerFatal', p: { msg: ev.message || '?' } };
      // 永久にロード中にならないよう、待機中の要求をすべて失敗させる
      for (const [, p] of this.pending) p.reject(new WorkerError(msg));
      this.pending.clear();
      this.onFatal?.(msg);
    };
    this.worker.onmessageerror = () => this.onFatal?.({ k: 'st.workerMsg' });
  }

  private handle(r: Res) {
    const p = this.pending.get(r.reqId);
    if (!p) return;
    if (r.type === 'progress') {
      p.onProgress?.(r);
      return;
    }
    this.pending.delete(r.reqId);
    if (r.type === 'error') {
      p.reject(new WorkerError(r.msg, r.stage));
    } else p.resolve(r);
  }

  request<T extends Res['type']>(body: ReqBody, onProgress?: (r: Res) => void): Promise<Extract<Res, { type: T }> | Res> {
    const reqId = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject, onProgress });
      this.worker.postMessage({ ...body, reqId } as Req);
    });
  }
}
