const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function runSyntaxTests(appRoot, extensionRoot) {
  // Use the same tokenizer and Go grammar as the installed editor, without
  // copying its grammar or adding a separate highlighting implementation.
  const modules = fs.existsSync(path.join(appRoot, 'node_modules.asar'))
    ? path.join(appRoot, 'node_modules.asar')
    : path.join(appRoot, 'node_modules');
  const textmate = require(path.join(modules, 'vscode-textmate'));
  const oniguruma = require(path.join(modules, 'vscode-oniguruma'));
  const wasm = fs.readFileSync(path.join(modules, 'vscode-oniguruma/release/onig.wasm'));
  await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new textmate.Registry({
    onigLib: Promise.resolve(oniguruma),
    loadGrammar: async (scope) => {
      const file = scope === 'source.gon'
        ? path.join(extensionRoot, 'syntaxes/gon.tmLanguage.json')
        : scope === 'source.go'
          ? path.join(appRoot, 'extensions/go/syntaxes/go.tmLanguage.json')
          : undefined;
      return file ? textmate.parseRawGrammar(fs.readFileSync(file, 'utf8'), file) : null;
    }
  });
  try {
    const grammar = await registry.loadGrammar('source.gon');
    assert.ok(grammar);
    let state = textmate.INITIAL;
    function scopes(line, text) {
      const result = grammar.tokenizeLine(line, state);
      state = result.ruleStack;
      const index = line.indexOf(text);
      assert.ok(index >= 0, `missing ${text}`);
      return result.tokens.find((t) => t.startIndex <= index && index < t.endIndex).scopes;
    }
    function has(line, text, scope) {
      assert.ok(scopes(line, text).includes(scope), `${line}: ${text} must have ${scope}`);
    }
    function ordinary(line, text) {
      assert.ok(!scopes(line, text).some((s) => s.startsWith('keyword.') && s.endsWith('.gon')), line);
    }
    has('type Message enum {', 'enum', 'keyword.declaration.enum.gon');
    scopes(' default Empty', 'Empty');
    scopes(' Text(string)', 'Text');
    scopes('}', '}');
    has('type Generic[T any] enum {', 'enum', 'keyword.declaration.enum.gon');
    scopes(' default Empty', 'Empty');
    scopes('}', '}');
    ordinary('type Alias enum', 'enum');
    ordinary('var enum = 3', 'enum');
    ordinary('var Option = 1', 'Option');
    ordinary('var Result = 1', 'Result');
    has('func feature() {', '{', 'punctuation.definition.begin.bracket.curly.go');
    has(' name := user?.Name ?? "guest"', '?.', 'keyword.operator.null-safety.gon');
    has(' name = user?.Name ?? "guest"', '??', 'keyword.operator.null-safety.gon');
    has(' value ??= 4', '??=', 'keyword.operator.null-safety.gon');
    has(' answer := optional?', '?', 'keyword.operator.null-safety.gon');
    has(' var optional int?', '?', 'keyword.operator.null-safety.gon');
    has(' var pointer (*User)? = nil', '?', 'keyword.operator.null-safety.gon');
    has(' var nested (int?)?', '?', 'keyword.operator.null-safety.gon');
    has(' var result Result[int?, error]', '?', 'keyword.operator.null-safety.gon');
    has(' return .Ok(3)', 'Ok', 'entity.name.function.variant.gon');
    has(' return .Err(problem)', 'Err', 'entity.name.function.variant.gon');
    assert.ok(!scopes(' value := Result[int, error].Ok(3)', 'Ok').includes('entity.name.function.variant.gon'));
    assert.ok(!scopes(' value := object.Some(3)', 'Some').includes('entity.name.function.variant.gon'));
    assert.ok(!scopes(' // .Ok(3) T?', 'Ok').includes('entity.name.function.variant.gon'));
    assert.ok(!scopes(' s := ".Some(3) T?"', 'Some').includes('entity.name.function.variant.gon'));

    has(' run := () => { callback?(1) }', '=>', 'keyword.operator.arrow.gon');
    has(' callback?(1)', '?', 'keyword.operator.null-safety.gon');
    has(' result := read() or problem { return }', 'or', 'keyword.control.error.gon');
    ordinary(' or := 3', 'or');
    ordinary(' // type Message enum { => ?. ??= or problem {', '=>');
    ordinary(' s := "enum => ?. ??= or problem {"', '=>');
    ordinary(" r := '?'", '?');
    ordinary(' s = `', '`');
    ordinary('enum => ?. ??= or problem {', '=>');
    ordinary('`', '`');
    scopes('}', '}');
    scopes('switch message {', '{');
    has('case Message.Text(text) => text', '=>', 'keyword.operator.arrow.gon');
    has('case value? => value', '?', 'keyword.operator.null-safety.gon');
    has('case (value?)? => value', '?', 'keyword.operator.null-safety.gon');
    has('case Message.Empty => "empty"', '=>', 'keyword.operator.arrow.gon');
    assert.ok(!scopes('case .Some(payload) => 0', 'Some').includes('entity.name.function.variant.gon'), 'shorthand patterns are not contextual construction');
    scopes('}', '}');

    const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'package.json'), 'utf8'));
    const snippets = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'snippets/gon.json'), 'utf8'));
    assert.ok(!Object.values(snippets).some((s) => JSON.stringify(s.body).includes('.Some') || JSON.stringify(s.body).includes('.None')), 'retired constructors are absent');
    assert.ok(manifest.contributes.snippets.some((s) => s.language === 'gon' && s.path === './snippets/gon.json'));
    const packageRules = fs.readFileSync(path.join(extensionRoot, '.vscodeignore'), 'utf8');
    assert.ok(packageRules.includes('!snippets/gon.json'), 'VSIX includes Gon snippets');
    assert.equal(Object.keys(snippets).length, 11);
    assert.equal(snippets['Gon Result Ok'].body, '.Ok(${1:value})$0');
    assert.equal(snippets['Gon Result Err'].body, '.Err(${1:err})$0');
    assert.ok(snippets['Gon qualified Result Ok'].body.startsWith('Result['));
    assert.ok(snippets['Gon optional declaration'].body.includes('${2:int}?'));
    assert.ok(snippets['Gon exhaustive match'].body.every((line) => !line.includes('case .')), 'match patterns stay qualified');
    const configuration = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'languages/gon.language-configuration.json'), 'utf8'));
    const increase = new RegExp(configuration.indentationRules.increaseIndentPattern);
    const decrease = new RegExp(configuration.indentationRules.decreaseIndentPattern);
    for (const line of ['case Feature.Text(text) =>', 'default =>', 'case ordinary:', 'type Feature enum {']) {
      assert.ok(increase.test(line), `indent after ${line}`);
    }
    assert.ok(!increase.test('case Feature.Text(text) => text'), 'value arm does not indent the following arm');
    for (const line of ['case Feature.Text(text) => text', 'default => "fallback"', 'case ordinary:']) {
      assert.ok(decrease.test(line), `align ${line}`);
    }
    console.log('PASS: actual VS Code TextMate tokenizer, contextual enum, nested operators, optional types, contextual construction, comment/string isolation, qualified match indentation, snippet packaging');
  } finally {
    registry.dispose();
  }
}

module.exports = { runSyntaxTests };

if (require.main === module) {
  const executable = process.env.VSCODE_EXECUTABLE;
  if (!executable) {
    throw new Error('Set VSCODE_EXECUTABLE to the installed VS Code executable');
  }
  const appRoot = process.env.VSCODE_APP_ROOT ?? (process.platform === 'darwin'
    ? path.resolve(executable, '../../Resources/app')
    : path.join(path.dirname(executable), 'resources/app'));
  if (!process.versions.electron && fs.existsSync(path.join(appRoot, 'node_modules.asar'))) {
    const result = spawnSync(executable, [__filename], {
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_APP_ROOT: appRoot }
    });
    process.exitCode = result.status ?? 1;
  } else {
    runSyntaxTests(appRoot, path.resolve(__dirname, '..')).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
