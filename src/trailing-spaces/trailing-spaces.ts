'use strict';

import * as vscode from 'vscode';
import { LogLevel, ILogger, Logger } from './utils/logger';
import { Config } from './config';
import jsdiff = require('diff');
import fs = require('fs');

interface TrailingRegions {
    offendingLines: vscode.Range[],
    highlightable: vscode.Range[]
}

export default class TrailingSpaces {

    private logger: ILogger;
    private config: Config;
    private decorationOptions: vscode.DecorationRenderOptions = {
        borderRadius: "3px",
        borderWidth: "1px",
        borderStyle: "solid",
        backgroundColor: "rgba(255,0,0,0.3)",
        borderColor: "rgba(255,100,100,0.15)"
    };
    private decorationType: vscode.TextEditorDecorationType;
    private matchedRegions: { [id: string]: TrailingRegions; };
    private languagesToIgnore: { [id: string]: boolean; };

    constructor() {
        this.logger = Logger.getInstance();
        this.config = Config.getInstance();
        this.decorationType = vscode.window.createTextEditorDecorationType(this.decorationOptions);
        this.matchedRegions = {};
        this.languagesToIgnore = {};
    }

    public addListeners() {
        vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor) => {
            this.logger.log("onDidChangeActiveTextEditor event called - " + editor.document.fileName);
            if (this.config.get<boolean>("liveMatching"))
                return this.matchTrailingSpaces(editor);
            return;
        });

        vscode.window.onDidChangeTextEditorSelection((e: vscode.TextEditorSelectionChangeEvent) => {
            let editor = e.textEditor;
            this.logger.log("onDidChangeTextEditorSelection event called - " + editor.document.fileName);
            if (this.config.get<boolean>("liveMatching"))
                this.matchTrailingSpaces(editor);
            return;
        });
        vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
            this.logger.log("onDidChangeTextDocument event called - " + e.document.fileName);
            if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document == e.document)
                if (this.config.get<boolean>("liveMatching"))
                    this.matchTrailingSpaces(vscode.window.activeTextEditor);
        });
        vscode.workspace.onDidOpenTextDocument((document: vscode.TextDocument) => {
            this.logger.log("onDidOpenTextDocument event called - " + document.fileName);
            if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document == document)
                if (this.config.get<boolean>("liveMatching"))
                    this.matchTrailingSpaces(vscode.window.activeTextEditor);
        });
        vscode.workspace.onDidSaveTextDocument((document: vscode.TextDocument) => {
            this.logger.log("onDidSaveTextDocument event called - " + document.fileName);
            vscode.window.visibleTextEditors.forEach((editor: vscode.TextEditor) => {
                if (document.uri === editor.document.uri)
                    if (this.config.get<boolean>("trimOnSave")) {
                        editor.edit((editBuilder: vscode.TextEditorEdit) => {
                            this.deleteTrailingSpaces(editor, editBuilder);
                        }).then(() => {
                            editor.document.save();
                        });
                    }
            });
        });
    }

    public initialize() {
        if (this.config.get<boolean>("liveMatching")) {
            vscode.window.visibleTextEditors.forEach((editor: vscode.TextEditor) => {
                this.matchTrailingSpaces(editor);
            });
            this.logger.log("All visible text editors highlighted");
        }
        this.config.get<string[]>("syntaxIgnore").map((language: string) => {
            this.languagesToIgnore[language] = true;
        })
    }

    public deleteTrailingSpaces(editor: vscode.TextEditor, editorEdit: vscode.TextEditorEdit): void {
        editor.edit((editBuilder: vscode.TextEditorEdit) => {
            this.deleteTrailingRegions(editor, editBuilder);
        }).then(() => {
            this.matchTrailingSpaces(editor);
            if (this.config.get<boolean>("saveAfterTrim") && !this.config.get<boolean>("trimOnSave"))
                editor.document.save();
        });
    }

    public deleteTrailingSpacesModifiedLinesOnly(editor: vscode.TextEditor, editorEdit: vscode.TextEditorEdit): void {
        editor.edit((editBuilder: vscode.TextEditorEdit) => {
            this.deleteTrailingRegions(editor, editBuilder, true);
        }).then(() => {
            this.matchTrailingSpaces(editor);
            if (this.config.get<boolean>("saveAfterTrim") && !this.config.get<boolean>("trimOnSave"))
                editor.document.save();
        });
    }

    public highlightTrailingSpaces(editor: vscode.TextEditor, editorEdit: vscode.TextEditorEdit): void {
        this.matchTrailingSpaces(editor);
    }

    private deleteTrailingRegions(editor: vscode.TextEditor, editorEdit: vscode.TextEditorEdit, overrideModifiedLinesConfig: boolean = false): void {
        let regions: vscode.Range[] = this.findRegionsToDelete(editor, overrideModifiedLinesConfig);

        if (regions) {
            regions.reverse();
            regions.forEach((region: vscode.Range) => {
                editorEdit.delete(region);
            });
        }

        let message: string;
        if (regions.length > 0) {
            message = "Deleted " + regions.length + " trailing spaces region" + (regions.length > 1 ? "s" : "");
        } else {
            message = "No trailing spaces to delete!";
        }

        this.logger.log(message);
        vscode.window.setStatusBarMessage(message, 3000);
    }

    private matchTrailingSpaces(editor: vscode.TextEditor): void {
        if (this.ignoreFile(editor)) {
            this.logger.log("File with langauge '" + editor.document.languageId + "' ignored.");
            return;
        }

        let regions: TrailingRegions = this.findTrailingSpaces(editor);
        this.addTrailingSpacesRegions(editor, regions);
        this.highlightTrailingSpacesRegions(editor, regions.highlightable);
    }

    private ignoreFile(editor: vscode.TextEditor): boolean {
        let viewSyntax: string = editor.document.languageId;
        return (this.languagesToIgnore[viewSyntax] == true);
    }

    private addTrailingSpacesRegions(editor: vscode.TextEditor, regions: TrailingRegions): void {
        this.matchedRegions[editor.document.uri.toString()] = regions;
    }

    private highlightTrailingSpacesRegions(editor: vscode.TextEditor, highlightable: vscode.Range[]): void {
        editor.setDecorations(this.decorationType, []);
        editor.setDecorations(this.decorationType, highlightable);
    }

    private modifiedLinesAsNumbers(oldFile: string, newFile: string): number[] {
        let diffs: jsdiff.IDiffResult[] = jsdiff.diffLines(oldFile, newFile);

        let lineNumber: number = 0;
        let editedLines: number[] = [];
        diffs.forEach((diff: jsdiff.IDiffResult) => {
            if (diff.added)
                editedLines.push(lineNumber);
            if (!diff.removed)
                lineNumber += diff.count;
        });
        return editedLines;
    }

    private getModifiedLineNumbers(editor: vscode.TextEditor): number[] {
        let onDisk: string = null;
        if (editor.document.fileName)
            onDisk = fs.readFileSync(editor.document.fileName, "utf-8");
        let onBuffer: string = editor.document.getText();

        return this.modifiedLinesAsNumbers(onDisk, onBuffer);
    }

    private findRegionsToDelete(editor: vscode.TextEditor, overrideModifiedLinesConfig: boolean = false): vscode.Range[] {
        let regions: TrailingRegions;

        if (this.config.get<boolean>("liveMatching") && this.matchedRegions[editor.document.uri.toString()])
            regions = this.matchedRegions[editor.document.uri.toString()];
        else
            regions = this.findTrailingSpaces(editor);

        if (this.config.get<boolean>("modifiedLinesOnly") || overrideModifiedLinesConfig) {
            let modifiedLines: number[] = this.getModifiedLineNumbers(editor);

            function onlyThoseWithTrailingSpaces(regions: TrailingRegions, modifiedLines: number[]): TrailingRegions {
                return {
                    offendingLines: regions.offendingLines.filter((range: vscode.Range) => {
                        return (modifiedLines.indexOf(range.start.line) >= 0);
                    }),
                    highlightable: []
                }
            }

            regions = onlyThoseWithTrailingSpaces(regions, modifiedLines);
        }
        return regions.offendingLines;
    }

    private findTrailingSpaces(editor: vscode.TextEditor): TrailingRegions {
        let sel: vscode.Selection = editor.selection;
        let line: vscode.TextLine = editor.document.lineAt(sel.end.line);

        let includeEmptyLines: boolean = this.config.get<boolean>("includeEmptyLines");
        let includeCurrentLine: boolean = this.config.get<boolean>("includeCurrentLine");

        let regexp: string = "(" + this.config.get<string>("regexp") + ")$";
        let noEmptyLinesRegexp = "\\S" + regexp;

        let offendingLines: vscode.Range[] = [];
        let offendingLinesRegexp: RegExp = new RegExp(includeEmptyLines ? regexp : noEmptyLinesRegexp);

        for (let i: number = 0; i < editor.document.lineCount; i++) {
            let currLine: vscode.TextLine = editor.document.lineAt(i);
            let match: RegExpExecArray = offendingLinesRegexp.exec(currLine.text);
            if (match) {
                offendingLines.push(new vscode.Range(new vscode.Position(i, currLine.text.lastIndexOf(match[1])), currLine.range.end));
            }
        }

        if (includeCurrentLine) {
            return { offendingLines: offendingLines, highlightable: offendingLines };
        } else {
            let currentOffender: RegExpExecArray = offendingLinesRegexp.exec(line.text);
            let currentOffenderRange: vscode.Range = (!currentOffender) ? null : (new vscode.Range(new vscode.Position(line.lineNumber, line.text.lastIndexOf(currentOffender[1])), line.range.end));
            let removal: vscode.Range = (!currentOffenderRange) ? null : line.range.intersection(currentOffenderRange);
            let highlightable: vscode.Range[] = [];
            if (removal) {
                for (let i: number = 0; i < offendingLines.length; i++) {
                    if (!offendingLines[i].isEqual(currentOffenderRange)) {
                        highlightable.push(offendingLines[i]);
                    }
                }
            } else {
                highlightable = offendingLines;
            }
            return { offendingLines: offendingLines, highlightable: highlightable };
        }
    }

}