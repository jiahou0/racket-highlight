import * as vscode from 'vscode';
import { documentSnapshot, isCancellation, isRacket } from './documents';
import { BackendEdit, Worker } from './protocol';
import { Workspace } from './workspace';

export function registerOrganize(workspace: Workspace): vscode.Disposable {
  return vscode.commands.registerCommand('racket.organizeDefinitions', async (uri?: vscode.Uri) => {
    let worker: Worker | undefined;
    try {
      workspace.assertTrusted();
      const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
      if (!document || !isRacket(document)) return;
      const editor = await vscode.window.showTextDocument(document);
      const snapshot = documentSnapshot(document);
      worker = new Worker(workspace.context, 'organize', document.uri, workspace.log);
      const result = await worker.request<{ edits: BackendEdit[]; count: number }>('organize', {
        path: workspace.sourcePath(document.uri), text: snapshot.text,
      });
      if (document.isClosed || document.version !== snapshot.version) {
        throw new Error('Document changed; no changes made');
      }
      if (!result.edits.length) {
        void vscode.window.showInformationMessage('No duplicate definitions');
        return;
      }
      const applied = await editor.edit(builder => {
        for (const edit of result.edits) builder.replace(snapshot.range(edit.start, edit.end), edit.text);
      }, { undoStopBefore: true, undoStopAfter: true });
      if (!applied) throw new Error('Could not apply changes');
      void vscode.window.showInformationMessage(`Renamed ${result.count} definitions`);
    } catch (error) {
      if (!isCancellation(error)) void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      worker?.dispose();
    }
  });
}
