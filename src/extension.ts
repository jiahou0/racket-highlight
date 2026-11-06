import * as vscode from 'vscode';
import { Workspace } from './workspace';
import { registerEditor } from './editor';
import { registerHighlighting } from './highlighting';
import { registerNavigation } from './navigation';
import { registerRename } from './rename';
import { Relations } from './relations';
import { Runtime } from './runtime';
import { registerOrganize } from './organize';
import { registerStructuralEditing } from './structural';

export function activate(context: vscode.ExtensionContext): void {
  const workspace = new Workspace(context);
  context.subscriptions.push(
    workspace,
    ...registerHighlighting(workspace),
    ...registerEditor(workspace),
    ...registerNavigation(workspace),
    registerRename(workspace),
    ...registerStructuralEditing(workspace),
    new Relations(workspace),
    new Runtime(workspace),
    registerOrganize(workspace),
    vscode.commands.registerCommand('racket.reanalyze', () => workspace.reanalyze()),
    vscode.commands.registerCommand('racket.checkCurrentFile', () => workspace.checkCurrentFile()),
    vscode.commands.registerCommand('racket.cancelCheck', () => workspace.cancelCheck()),
  );
  workspace.start();
}
