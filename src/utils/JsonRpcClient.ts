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
    const controller = new AbortController();
    const timeoutId = timeoutMs
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

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
        signal: controller.signal,
      });

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

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
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms for method: ${method}`);
      }
      // エラーメッセージにメソッド名とパラメータを追加
      if (error.message && !error.message.includes(method)) {
        throw new Error(
          `${error.message} (method: ${method}, params: ${JSON.stringify(params)})`
        );
      }
      throw error;
    }
  }
}

