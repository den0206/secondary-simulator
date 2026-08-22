/**
 * JSON-RPC 2.0 クライアント実装
 * mobilecliサーバーとの通信に使用
 */
export class JsonRpcClient {
  constructor(private readonly baseUrl: string) {}

  async sendJsonRpcRequest<T = any>(
    method: string,
    params: any,
    timeoutMs?: number
  ): Promise<T> {
    const requestBody = {
      jsonrpc: '2.0',
      method,
      params,
      id: Date.now(),
    };

    try {
      const response = await fetch(`${this.baseUrl}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
          `HTTP error! status: ${response.status}, method: ${method}, response: ${errorText}`
        );
      }

      const result = await response.json();

      if (result.error) {
        const errorMessage = result.error.message || `JSON-RPC error: ${result.error.code}`;
        const errorDetails = result.error.data ? ` Details: ${JSON.stringify(result.error.data)}` : '';
        throw new Error(`${errorMessage}${errorDetails}`);
      }

      return result.result as T;
    } catch (error: any) {
      if (error.name === 'TimeoutError') {
        throw new Error(`Request timeout after ${timeoutMs}ms for method: ${method}`);
      }
      // 診断に要るのはメソッド名と deviceId だけ。params を丸ごと載せると
      // `device.io.text` の貼り付け内容（パスワード等）が例外メッセージに入り、
      // ログと webview のオーバーレイの両方へ出てしまう。
      if (error.message && !error.message.includes(method)) {
        const deviceId = params && typeof params === 'object' ? params.deviceId : undefined;
        const where = deviceId ? `${method}, device: ${deviceId}` : method;
        throw new Error(`${error.message} (method: ${where})`);
      }
      throw error;
    }
  }
}

