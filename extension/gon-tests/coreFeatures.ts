import * as assert from 'assert';
import type * as VSCode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFileSync } from 'child_process';

export const modernFeatures = `package main
import ("errors"; "fmt")
type Feature enum {
 default Empty
 Text(string)
 Count { Number int }
}
type FeatureUser struct { Name string }
func featureDescribe(value Feature) string {
 return switch value {
 case Feature.Empty => "empty"
 case Feature.Text(text) => text
 case Feature.Count{Number: number} => fmt.Sprint(number)
 }
}
func featureCombine(first, second int) int { return first*10+second }
func featureResult(value int) (int, error) {
 if value < 0 { return 0, errors.New("negative") }
 return value, nil
}
func featureTwice(value int) (int, error) {
 number := featureResult(value: value)!
 return number*2, nil
}
func featureOption(value int?) int? {
 number := value?
 return number+1
}
func featureSummary() string {
 number := featureTwice(value: 4) or problem { return problem.Error() }
 var user FeatureUser?
 name := user?.Name ?? "guest"
 maybe := featureOption(4) ?? 0
 return fmt.Sprintf("%s %d %d %s %d", featureDescribe(Feature.Text("ready")), number, maybe, name, featureCombine(second: 2, first: 1))
}
func featureFailure() string {
 _ = featureResult(value: -1) or problem { return problem.Error() }
 return "unexpected"
}
func featureRecord() string { return featureDescribe(Feature.Count{Number: 7}) }
func featureSimplifiedOptional(value int) (number int?) {
 if value < 0 { return nil }
 return value
}
func featureSimplifiedResult(value int) (port int?, err error) {
 if value < 0 { return nil, errors.New("negative") }
 if value == 0 { return nil, nil }
 return value, nil
}
func featureSimplifiedPresent(value *int) (*int)? { return value }
func featureSimplifiedSummary() string {
 var absent int? = nil
 number := featureSimplifiedResult(value: 8) or problem { return problem.Error() }
 var pointer *int
 explicit := featureSimplifiedPresent(value: pointer)
 present := switch explicit {
 case _? => true
 case nil => false
 }
 return fmt.Sprintf("%d %d %t %d", absent ?? -1, number ?? 0, present, featureSimplifiedOptional(value: 9) ?? 0)
}
func featurePattern(input int?) string {
 if input is matched? && matched > 0 { return $"present:\${matched:%02d}" }
 return "absent"
}
func featureAlternatives(value Feature) string {
 return switch value {
 case Feature.Empty, Feature.Count{Number: _} => "group"
 case Feature.Text(text) => text
 }
}
func featureContext(value int) (int, error) {
 return featureResult(value: value) or problem => fmt.Errorf("context:%w", problem), nil
}
func featureContextFailure() string {
 _ = featureContext(value: -1) or problem { return problem.Error() }
 return "unexpected"
}
func featureExtensions() string {
 var present int? = 3
 return $"\${featurePattern(present)} \${featureAlternatives(Feature.Count{Number: 9})} \${featureContextFailure()}"
}
`;

export const legacyFeatures = `package main
import ("errors"; "fmt")
type Feature struct { tag int; text string; number int }
type FeatureUser struct { Name string }
type FeatureOption struct { some bool; value int }
func featureDescribe(value Feature) string {
 switch value.tag {
 case 0: return "empty"
 case 1: return value.text
 case 2: return fmt.Sprint(value.number)
 }
 panic("invalid tag")
}
func featureCombine(first, second int) int { return first*10+second }
func featureResult(value int) (int, error) {
 if value < 0 { return 0, errors.New("negative") }
 return value, nil
}
func featureTwice(value int) (int, error) {
 number, err := featureResult(value)
 if err != nil { return 0, err }
 return number*2, nil
}
func featureOption(value FeatureOption) FeatureOption {
 if !value.some { return FeatureOption{} }
 return FeatureOption{some:true, value:value.value+1}
}
func featureSummary() string {
 number, problem := featureTwice(4)
 if problem != nil { return problem.Error() }
 var user *FeatureUser
 name := "guest"
 if user != nil { name = user.Name }
 option := featureOption(FeatureOption{some:true,value:4})
 maybe := 0
 if option.some { maybe = option.value }
 second, first := 2, 1
 return fmt.Sprintf("%s %d %d %s %d", featureDescribe(Feature{tag:1,text:"ready"}), number, maybe, name, featureCombine(first, second))
}
func featureFailure() string {
 _, problem := featureResult(-1)
 if problem != nil { return problem.Error() }
 return "unexpected"
}
func featureRecord() string { return featureDescribe(Feature{tag:2,number:7}) }
type FeatureOptionalPointer struct { some bool; value *int }
func featureSimplifiedOptional(value int) (number FeatureOption) {
 if value < 0 { return FeatureOption{} }
 return FeatureOption{some: true, value: value}
}
func featureSimplifiedResult(value int) (port FeatureOption, err error) {
 if value < 0 { return FeatureOption{}, errors.New("negative") }
 if value == 0 { return FeatureOption{}, nil }
 return FeatureOption{some: true, value: value}, nil
}
func featureSimplifiedPresent(value *int) FeatureOptionalPointer { return FeatureOptionalPointer{some: true, value: value} }
func featureSimplifiedSummary() string {
 var absent FeatureOption
 number, problem := featureSimplifiedResult(8)
 if problem != nil { return problem.Error() }
 var pointer *int
 explicit := featureSimplifiedPresent(pointer)
 absentValue := -1
 if absent.some { absentValue = absent.value }
 numberValue := 0
 if number.some { numberValue = number.value }
 optional := featureSimplifiedOptional(9)
 optionalValue := 0
 if optional.some { optionalValue = optional.value }
 return fmt.Sprintf("%d %d %t %d", absentValue, numberValue, explicit.some, optionalValue)
}
func featurePattern(input FeatureOption) string {
 if input.some && input.value > 0 { return fmt.Sprintf("present:%02d", input.value) }
 return "absent"
}
func featureAlternatives(value Feature) string {
 if value.tag == 0 || value.tag == 2 { return "group" }
 return value.text
}
func featureContext(value int) (int, error) {
 result, err := featureResult(value)
 if err != nil { return 0, fmt.Errorf("context:%w", err) }
 return result, nil
}
func featureContextFailure() string {
 _, problem := featureContext(-1)
 if problem != nil { return problem.Error() }
 return "unexpected"
}
func featureExtensions() string {
 return fmt.Sprintf("%s %s %s", featurePattern(FeatureOption{some:true, value:3}), featureAlternatives(Feature{tag:2,number:9}), featureContextFailure())
}
`;

async function until<T>(action: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const result = await action();
    if (result !== undefined) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + message);
}

export async function checkCoreFeatures(extension: VSCode.Extension<unknown>, temporary: string) {
  const vscode: typeof VSCode = require('vscode');
  const syntax = require(path.join(extension.extensionPath, 'gon-tests/syntax.cjs'));
  await syntax.runSyntaxTests(vscode.env.appRoot, extension.extensionPath);
  const folder = path.join(temporary, 'gon project & spaces');
  const uri = vscode.Uri.file(path.join(folder, 'core_features.go'));
  let document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);
  await until(async () => {
    document = await vscode.workspace.openTextDocument(uri);
    return document.languageId === 'gon' ? true : undefined;
  }, 'modern feature language selection');
  const text = document.getText();
  const labelPosition = document.positionAt(text.indexOf('second: 2'));
  const definitions = await until(async () => {
    const results = await vscode.commands.executeCommand<(VSCode.Location | VSCode.LocationLink)[]>(
      'vscode.executeDefinitionProvider', uri, labelPosition
    );
    return results?.length ? results : undefined;
  }, 'named argument definition through the extension client');
  const target = definitions[0];
  const range = 'targetRange' in target ? target.targetSelectionRange : target.range;
  assert.ok(range);
  assert.equal(document.getText(range), 'second');
  assert.ok(document.lineAt(range.start.line).text.includes('func featureCombine'));
  const errors = vscode.languages.getDiagnostics(uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
  assert.deepEqual(errors.map((d) => d.message), [], 'implemented Gon features must have no editor errors: ' + JSON.stringify(errors.map((d) => ({message:d.message, line:d.range.start.line}))));
  for (const name of ['Feature.Text(text)', 'featureResult(value: value)', 'int?']) {
    const hovers = await until(async () => {
      const results = await vscode.commands.executeCommand<VSCode.Hover[]>(
        'vscode.executeHoverProvider', uri, document.positionAt(text.indexOf(name))
      );
      return results?.length ? results : undefined;
    }, `${name} hover through the extension client`);
    assert.ok(hovers.length);
  }
  const formatEdits = await vscode.commands.executeCommand<VSCode.TextEdit[]>(
    'vscode.executeFormatDocumentProvider', uri, { tabSize: 8, insertSpaces: false }
  );
  assert.ok(formatEdits?.length, 'Gon formatting provider handles new constructs');
  let formatted = text;
  for (const edit of [...(formatEdits ?? [])].sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start))) {
    formatted = formatted.slice(0, document.offsetAt(edit.range.start)) + edit.newText + formatted.slice(document.offsetAt(edit.range.end));
  }
  assert.ok(formatted.includes('(port int?, err error)') && formatted.includes('(*int)?'), 'formatting preserves optional type grouping and named results');
  for (const spelling of ['case _?', 'case nil', 'is matched?', 'or problem =>', '$"present:', 'case Feature.Empty, Feature.Count']) {
    assert.ok(formatted.includes(spelling), `formatting preserves ${spelling}`);
  }
  const binding = text.indexOf('is matched') + 'is '.length;
  const bindingDefinitions = await until(async () => {
    const results = await vscode.commands.executeCommand<(VSCode.Location | VSCode.LocationLink)[]>(
      'vscode.executeDefinitionProvider', uri, document.positionAt(text.indexOf('${matched') + 2)
    );
    return results?.length ? results : undefined;
  }, 'interpolated pattern binding definition');
  const bindingTarget = bindingDefinitions[0];
  const bindingRange = 'targetRange' in bindingTarget ? (bindingTarget.targetSelectionRange ?? bindingTarget.targetRange) : bindingTarget.range;
  assert.equal(document.offsetAt(bindingRange.start), binding);
  const rename = await vscode.commands.executeCommand<VSCode.WorkspaceEdit>(
    'vscode.executeDocumentRenameProvider', uri, document.positionAt(binding), 'count'
  );
  assert.equal(rename?.get(uri)?.filter((edit) => edit.newText === 'count').length, 3, 'rename covers pattern declaration, guard and interpolated reference');
  const completion = await until(async () => {
    const result = await vscode.commands.executeCommand<VSCode.CompletionList>(
      'vscode.executeCompletionItemProvider', uri, document.positionAt(text.indexOf('&& matched') + '&& mat'.length)
    );
    return result?.items.some((item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'matched') ? result : undefined;
  }, 'pattern binding completion in the later && operand');
  assert.ok(completion.items.length);
  const signature = await until(async () => {
    const result = await vscode.commands.executeCommand<VSCode.SignatureHelp>(
      'vscode.executeSignatureHelpProvider', uri, document.positionAt(text.indexOf('featureResult(value: value)') + 'featureResult('.length)
    );
    return result?.signatures.length ? result : undefined;
  }, 'named error-tuple call signature');
  assert.ok(signature.signatures[0].label.includes('value int'), signature.signatures[0].label);

  const compiler = path.join(process.env.GON_ROOT!, 'gon/bin/gon');
  const outputs: string[] = [];
  for (const [name, source, commands] of [
    ['modern', modernFeatures, [compiler]],
    ['legacy', legacyFeatures, [compiler, process.env.GON_BASELINE_GO!]]
  ] as const) {
    const executableFolder = path.join(temporary, `features-${name}`);
    await fs.mkdir(executableFolder);
    await fs.writeFile(path.join(executableFolder, 'go.mod'), 'module example.com/features\n\ngo 1.27\n');
    await fs.writeFile(path.join(executableFolder, 'features.go'), source);
    await fs.writeFile(path.join(executableFolder, 'main.go'), `package main
import "fmt"
func main(){fmt.Println(featureSummary());fmt.Println(featureRecord());fmt.Println(featureFailure());fmt.Println(featureSimplifiedSummary());fmt.Println(featureExtensions())}
`);
    for (const command of commands) {
      outputs.push(execFileSync(command, ['run', '.'], { cwd: executableFolder, encoding: 'utf8' }));
    }
  }
  assert.deepEqual(outputs, Array(3).fill('ready 8 5 guest 12\n7\nnegative\n-1 8 true 9\npresent:03 group context:negative\n'));
  const configuration = vscode.workspace.getConfiguration('gon', uri);
  const previous = configuration.inspect('serverSettings')?.workspaceFolderValue;
  try {
    for (const enabled of [false, true]) {
      await configuration.update('serverSettings', { semanticTokens: true, nilaway: enabled }, vscode.ConfigurationTarget.WorkspaceFolder);
      let finish!: (code: number | undefined) => void;
      const done = new Promise<number | undefined>((resolve) => { finish = resolve; });
      const listener = vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution.task.definition.type === 'gon-check') { finish(event.exitCode); }
      });
      try {
        const execution = await vscode.commands.executeCommand<VSCode.TaskExecution>('gon.checkProject', uri);
        assert.ok(execution);
        const task = execution.task.execution as VSCode.ProcessExecution;
        assert.deepEqual(task.args, ['check', './...', ...(enabled ? ['--nilaway'] : [])]);
        assert.equal(await done, 0, 'editor-selected nil analysis preserves successful check status');
      } finally { listener.dispose(); }
    }
  } finally {
    await configuration.update('serverSettings', previous, vscode.ConfigurationTarget.WorkspaceFolder);
  }
  console.log('PASS: extension-host enum/match/native optional/error-tuple/named-argument, multi-pattern/is/error-context/interpolation, hover, definitions, rename, signatures, completion, formatting, legacy/modern/baseline execution');
}
