import {randomUUID} from 'node:crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import {MjpegProxy} from '../capture/MjpegProxy';
import {SidecarCapture} from '../capture/SidecarCapture';
import {webviewStrings} from '../utils/Strings';

/** `media/webview/index.html` に CSP・nonce・翻訳辞書を埋めて返す。 */
export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri
): string {
  const nonce = randomUUID().replace(/-/g, '');
  const media = (file: string) =>
    vscode.Uri.joinPath(extensionUri, 'media', 'webview', file);
  const scriptUri = webview.asWebviewUri(media('main.js'));
  const styleUri = webview.asWebviewUri(media('style.css'));
  // 直結ストリームは preferredPort から最大 20 ポートを試すため、範囲を CSP に含める。
  // 設定の ON/OFF で HTML を作り直さないので、使わないときも範囲を許可しておく
  // （トークンが無いと絵は取れない。localhost 以外には開かない）。
  const range = (base: number, count: number) =>
    Array.from({length: count}, (_, i) => ` http://localhost:${base + i}`).join('');
  const proxyOrigins = range(MjpegProxy.BASE_PORT, MjpegProxy.MAX_PORT_TRIES);
  // サイドカーの直結配信も同じ理由で範囲を許可する（開始時にポートが未定のため）
  const sidecarOrigins = range(
    SidecarCapture.STREAM_BASE_PORT,
    SidecarCapture.MAX_PORT_TRIES
  );
  const extra = proxyOrigins + sidecarOrigins;
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:${extra}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">`;

  const html = fs.readFileSync(media('index.html').fsPath, 'utf8');
  return html
    .replace('{{scriptUri}}', scriptUri.toString())
    .replace('{{styleUri}}', styleUri.toString())
    .replace('{{nonce}}', nonce)
    .replace('{{cspMeta}}', cspMeta)
    .replace('{{l10n}}', embedJson(webviewStrings()));
}

/**
 * `<script type="application/json">` へ埋める JSON。
 *
 * `<` を `<` へ逃がす。文言に `</script>` が入るとその場でブロックが閉じ、
 * 後続が HTML として解釈されてしまう（今の文言には無いが、翻訳を足すのは人なので
 * 埋め込む側で断つ）。
 */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
