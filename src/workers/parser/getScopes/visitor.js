/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// @flow

import isEmpty from "lodash/isEmpty";
import type { SourceId, Location } from "../../../types";
import * as t from "@babel/types";
import type {
  Node,
  TraversalAncestors,
  Location as BabelLocation
} from "@babel/types";
import { isGeneratedId } from "devtools-source-map";
import getFunctionName from "../utils/getFunctionName";
import { getAst } from "../utils/ast";

/**
 * "implicit"
 * Variables added automaticly like "this" and "arguments"
 *
 * "var"
 * Variables declared with "var" or non-block function declarations
 *
 * "let"
 * Variables declared with "let".
 *
 * "const"
 * Variables declared with "const", or added as const
 * bindings like inner function expressions and inner class names.
 *
 * "import"
 * Imported binding names exposed from other modules.
 */
export type BindingType = "implicit" | "var" | "const" | "let" | "import";

export type BindingLocationType = "ref" | "decl";
export type BindingLocation = BindingDeclarationLocation | BindingRefLocation;

export type BindingRefLocation = {
  type: "ref",
  start: Location,
  end: Location,
  meta?: BindingMetaValue | null
};
export type BindingDeclarationLocation = {
  type: "decl",
  start: Location,
  end: Location,

  // The overall location of the declaration that this binding is part of.
  declaration: {
    start: Location,
    end: Location
  },

  // If this declaration was an import, include the name of the imported
  // binding that this binding references.
  importName?: string
};
export type BindingData = {
  type: BindingType,
  refs: Array<BindingLocation>
};

// Location information about the expression immediartely surrounding a
// given binding reference.
export type BindingMetaValue =
  | {
      type: "inherit",
      start: Location,
      end: Location,
      parent: BindingMetaValue | null
    }
  | {
      type: "call",
      start: Location,
      end: Location,
      parent: BindingMetaValue | null
    }
  | {
      type: "member",
      start: Location,
      end: Location,
      property: string,
      parent: BindingMetaValue | null
    };

export type ScopeBindingList = {
  [name: string]: BindingData
};

export type SourceScope = {
  type: "object" | "function" | "block",
  displayName: string,
  start: Location,
  end: Location,
  bindings: ScopeBindingList
};

export type ParsedScope = SourceScope & {
  children: ?(ParsedScope[])
};

export type ParseJSScopeVisitor = {
  traverseVisitor: any,
  toParsedScopes: () => ParsedScope[]
};

type TempScope = {
  type: "object" | "function" | "block" | "module",
  displayName: string,
  parent: TempScope | null,
  children: Array<TempScope>,
  loc: BabelLocation,
  bindings: ScopeBindingList
};

type ScopeCollectionVisitorState = {
  sourceId: SourceId,
  scope: TempScope,
  scopeStack: Array<TempScope>
};

export function parseSourceScopes(sourceId: SourceId): ?Array<ParsedScope> {
  const ast = getAst(sourceId);
  if (isEmpty(ast)) {
    return null;
  }

  const { global, lexical } = createGlobalScope(ast, sourceId);

  const state = {
    sourceId,
    scope: lexical,
    scopeStack: []
  };
  t.traverse(ast, scopeCollectionVisitor, state);

  // TODO: This should probably check for ".mjs" extension on the
  // original file, and should also be skipped if the the generated
  // code is an ES6 module rather than a script.
  if (
    isGeneratedId(sourceId) ||
    ((ast: any).program.sourceType === "script" && !looksLikeCommonJS(global))
  ) {
    stripModuleScope(global);
  }

  return toParsedScopes([global], sourceId) || [];
}

function toParsedScopes(
  children: TempScope[],
  sourceId: SourceId
): ?(ParsedScope[]) {
  if (!children || children.length === 0) {
    return undefined;
  }
  return children.map(scope => {
    // Removing unneed information from TempScope such as parent reference.
    // We also need to convert BabelLocation to the Location type.
    return {
      start: scope.loc.start,
      end: scope.loc.end,
      type: scope.type === "module" ? "block" : scope.type,
      displayName: scope.displayName,
      bindings: scope.bindings,
      children: toParsedScopes(scope.children, sourceId)
    };
  });
}

function createTempScope(
  type: "object" | "function" | "block" | "module",
  displayName: string,
  parent: TempScope | null,
  loc: {
    start: Location,
    end: Location
  }
): TempScope {
  const result = {
    type,
    displayName,
    parent,
    children: [],
    loc,
    bindings: (Object.create(null): any)
  };
  if (parent) {
    parent.children.push(result);
  }
  return result;
}
function pushTempScope(
  state: ScopeCollectionVisitorState,
  type: "object" | "function" | "block" | "module",
  displayName: string,
  loc: {
    start: Location,
    end: Location
  }
): TempScope {
  const scope = createTempScope(type, displayName, state.scope, loc);

  state.scope = scope;
  return scope;
}

function isNode(node?: Node, type: string): boolean {
  return node ? node.type === type : false;
}

function getVarScope(scope: TempScope): TempScope {
  let s = scope;
  while (s.type !== "function" && s.type !== "module") {
    if (!s.parent) {
      return s;
    }
    s = s.parent;
  }
  return s;
}

function fromBabelLocation(
  location: BabelLocation,
  sourceId: SourceId
): Location {
  return {
    sourceId,
    line: location.line,
    column: location.column
  };
}

function parseDeclarator(
  declaratorId: Node,
  targetScope: TempScope,
  type: BindingType,
  declaration: Node,
  sourceId: SourceId
) {
  if (isNode(declaratorId, "Identifier")) {
    let existing = targetScope.bindings[declaratorId.name];
    if (!existing) {
      existing = {
        type,
        refs: []
      };
      targetScope.bindings[declaratorId.name] = existing;
    }
    existing.refs.push({
      type: "decl",
      start: fromBabelLocation(declaratorId.loc.start, sourceId),
      end: fromBabelLocation(declaratorId.loc.end, sourceId),
      declaration: {
        start: fromBabelLocation(declaration.loc.start, sourceId),
        end: fromBabelLocation(declaration.loc.end, sourceId)
      }
    });
  } else if (isNode(declaratorId, "ObjectPattern")) {
    declaratorId.properties.forEach(prop => {
      parseDeclarator(prop.value, targetScope, type, declaration, sourceId);
    });
  } else if (isNode(declaratorId, "ArrayPattern")) {
    declaratorId.elements.forEach(item => {
      parseDeclarator(item, targetScope, type, declaration, sourceId);
    });
  } else if (isNode(declaratorId, "AssignmentPattern")) {
    parseDeclarator(
      declaratorId.left,
      targetScope,
      type,
      declaration,
      sourceId
    );
  } else if (isNode(declaratorId, "RestElement")) {
    parseDeclarator(
      declaratorId.argument,
      targetScope,
      type,
      declaration,
      sourceId
    );
  }
}

function isLetOrConst(node) {
  return node.kind === "let" || node.kind === "const";
}

function hasLexicalDeclaration(node, parent) {
  const isFunctionBody = t.isFunction(parent, { body: node });

  return node.body.some(
    child =>
      isLexicalVariable(child) ||
      (!isFunctionBody && child.type === "FunctionDeclaration") ||
      child.type === "ClassDeclaration"
  );
}
function isLexicalVariable(node) {
  return isNode(node, "VariableDeclaration") && isLetOrConst(node);
}

function findIdentifierInScopes(
  scope: TempScope,
  name: string
): TempScope | null {
  // Find nearest outer scope with the specifed name and add reference.
  for (let s = scope; s; s = s.parent) {
    if (name in s.bindings) {
      return s;
    }
  }
  return null;
}

function createGlobalScope(
  ast: BabelNode,
  sourceId: SourceId
): { global: TempScope, lexical: TempScope } {
  const global = createTempScope("object", "Global", null, {
    start: fromBabelLocation(ast.loc.start, sourceId),
    end: fromBabelLocation(ast.loc.end, sourceId)
  });

  // Include fake bindings to collect references to CommonJS
  Object.assign(global.bindings, {
    module: {
      type: "var",
      refs: []
    },
    exports: {
      type: "var",
      refs: []
    },
    __dirname: {
      type: "var",
      refs: []
    },
    __filename: {
      type: "var",
      refs: []
    },
    require: {
      type: "var",
      refs: []
    }
  });

  const lexical = createTempScope("block", "Lexical Global", global, {
    start: fromBabelLocation(ast.loc.start, sourceId),
    end: fromBabelLocation(ast.loc.end, sourceId)
  });

  return {
    global,
    lexical
  };
}

const scopeCollectionVisitor = {
  // eslint-disable-next-line complexity
  enter(
    node: Node,
    ancestors: TraversalAncestors,
    state: ScopeCollectionVisitorState
  ) {
    state.scopeStack.push(state.scope);

    const parentNode =
      ancestors.length === 0 ? null : ancestors[ancestors.length - 1].node;

    if (t.isProgram(node)) {
      const scope = pushTempScope(state, "module", "Module", {
        start: fromBabelLocation(node.loc.start, state.sourceId),
        end: fromBabelLocation(node.loc.end, state.sourceId)
      });
      scope.bindings.this = {
        type: "implicit",
        refs: []
      };
    } else if (t.isFunction(node)) {
      let scope = state.scope;
      if (t.isFunctionExpression(node) && isNode(node.id, "Identifier")) {
        scope = pushTempScope(state, "block", "Function Expression", {
          start: fromBabelLocation(node.loc.start, state.sourceId),
          end: fromBabelLocation(node.loc.end, state.sourceId)
        });
        scope.bindings[node.id.name] = {
          type: "const",
          refs: [
            {
              type: "decl",
              start: fromBabelLocation(node.id.loc.start, state.sourceId),
              end: fromBabelLocation(node.id.loc.end, state.sourceId),
              declaration: {
                start: fromBabelLocation(node.loc.start, state.sourceId),
                end: fromBabelLocation(node.loc.end, state.sourceId)
              }
            }
          ]
        };
      }

      if (t.isFunctionDeclaration(node) && isNode(node.id, "Identifier")) {
        // This ignores Annex B function declaration hoisting, which
        // is probably a fine assumption.
        const fnScope = getVarScope(scope);
        scope.bindings[node.id.name] = {
          type: fnScope === scope ? "var" : "let",
          refs: [
            {
              type: "decl",
              start: fromBabelLocation(node.id.loc.start, state.sourceId),
              end: fromBabelLocation(node.id.loc.end, state.sourceId),
              declaration: {
                start: fromBabelLocation(node.loc.start, state.sourceId),
                end: fromBabelLocation(node.loc.end, state.sourceId)
              }
            }
          ]
        };
      }

      scope = pushTempScope(
        state,
        "function",
        getFunctionName(node, parentNode),
        {
          // Being at the start of a function doesn't count as
          // being inside of it.
          start: fromBabelLocation(
            node.params[0] ? node.params[0].loc.start : node.loc.start,
            state.sourceId
          ),
          end: fromBabelLocation(node.loc.end, state.sourceId)
        }
      );

      node.params.forEach(param =>
        parseDeclarator(param, scope, "var", node, state.sourceId)
      );

      if (!t.isArrowFunctionExpression(node)) {
        scope.bindings.this = {
          type: "implicit",
          refs: []
        };
        scope.bindings.arguments = {
          type: "implicit",
          refs: []
        };
      }
    } else if (t.isClass(node)) {
      if (t.isClassDeclaration(node) && t.isIdentifier(node.id)) {
        state.scope.bindings[node.id.name] = {
          type: "let",
          refs: [
            {
              type: "decl",
              start: fromBabelLocation(node.id.loc.start, state.sourceId),
              end: fromBabelLocation(node.id.loc.end, state.sourceId),
              declaration: {
                start: fromBabelLocation(node.loc.start, state.sourceId),
                end: fromBabelLocation(node.loc.end, state.sourceId)
              }
            }
          ]
        };
      }

      if (t.isIdentifier(node.id)) {
        const scope = pushTempScope(state, "block", "Class", {
          start: fromBabelLocation(node.loc.start, state.sourceId),
          end: fromBabelLocation(node.loc.end, state.sourceId)
        });

        scope.bindings[node.id.name] = {
          type: "const",
          refs: [
            {
              type: "decl",
              start: fromBabelLocation(node.id.loc.start, state.sourceId),
              end: fromBabelLocation(node.id.loc.end, state.sourceId),
              declaration: {
                start: fromBabelLocation(node.loc.start, state.sourceId),
                end: fromBabelLocation(node.loc.end, state.sourceId)
              }
            }
          ]
        };
      }
    } else if (t.isForXStatement(node) || t.isForStatement(node)) {
      const init = node.init || node.left;
      if (isNode(init, "VariableDeclaration") && isLetOrConst(init)) {
        // Debugger will create new lexical environment for the for.
        pushTempScope(state, "block", "For", {
          // Being at the start of a for loop doesn't count as
          // being inside it.
          start: fromBabelLocation(init.loc.start, state.sourceId),
          end: fromBabelLocation(node.loc.end, state.sourceId)
        });
      }
    } else if (t.isCatchClause(node)) {
      const scope = pushTempScope(state, "block", "Catch", {
        start: fromBabelLocation(node.loc.start, state.sourceId),
        end: fromBabelLocation(node.loc.end, state.sourceId)
      });
      parseDeclarator(node.param, scope, "var", node, state.sourceId);
    } else if (
      t.isBlockStatement(node) &&
      hasLexicalDeclaration(node, parentNode)
    ) {
      // Debugger will create new lexical environment for the block.
      pushTempScope(state, "block", "Block", {
        start: fromBabelLocation(node.loc.start, state.sourceId),
        end: fromBabelLocation(node.loc.end, state.sourceId)
      });
    } else if (
      t.isVariableDeclaration(node) &&
      (node.kind === "var" ||
        // Lexical declarations in for statements are handled above.
        !t.isForStatement(parentNode, { init: node }) ||
        !t.isForXStatement(parentNode, { left: node }))
    ) {
      // Finds right lexical environment
      const hoistAt = !isLetOrConst(node)
        ? getVarScope(state.scope)
        : state.scope;
      node.declarations.forEach(declarator => {
        parseDeclarator(
          declarator.id,
          hoistAt,
          node.kind,
          node,
          state.sourceId
        );
      });
    } else if (t.isImportDeclaration(node)) {
      node.specifiers.forEach(spec => {
        if (t.isImportNamespaceSpecifier(spec)) {
          state.scope.bindings[spec.local.name] = {
            // Imported namespaces aren't live import bindings, they are
            // just normal const bindings.
            type: "const",
            refs: [
              {
                type: "decl",
                start: fromBabelLocation(spec.local.loc.start, state.sourceId),
                end: fromBabelLocation(spec.local.loc.end, state.sourceId)
              }
            ]
          };
        } else {
          state.scope.bindings[spec.local.name] = {
            type: "import",
            refs: [
              {
                type: "decl",
                start: fromBabelLocation(spec.local.loc.start, state.sourceId),
                end: fromBabelLocation(spec.local.loc.end, state.sourceId),
                importName: t.isImportDefaultSpecifier(spec)
                  ? "default"
                  : spec.imported.name,
                declaration: {
                  start: fromBabelLocation(node.loc.start, state.sourceId),
                  end: fromBabelLocation(node.loc.end, state.sourceId)
                }
              }
            ]
          };
        }
      });
    } else if (t.isIdentifier(node) && t.isReferenced(node, parentNode)) {
      const identScope = findIdentifierInScopes(state.scope, node.name);
      if (identScope) {
        identScope.bindings[node.name].refs.push({
          type: "ref",
          start: fromBabelLocation(node.loc.start, state.sourceId),
          end: fromBabelLocation(node.loc.end, state.sourceId),
          meta: buildMetaBindings(state.sourceId, node, ancestors)
        });
      }
    } else if (t.isThisExpression(node)) {
      const identScope = findIdentifierInScopes(state.scope, "this");
      if (identScope) {
        identScope.bindings.this.refs.push({
          type: "ref",
          start: fromBabelLocation(node.loc.start, state.sourceId),
          end: fromBabelLocation(node.loc.end, state.sourceId),
          meta: buildMetaBindings(state.sourceId, node, ancestors)
        });
      }
    } else if (t.isClassProperty(parentNode, { value: node })) {
      const scope = pushTempScope(state, "function", "Class Field", {
        start: fromBabelLocation(node.loc.start, state.sourceId),
        end: fromBabelLocation(node.loc.end, state.sourceId)
      });
      scope.bindings.this = {
        type: "implicit",
        refs: []
      };
      scope.bindings.arguments = {
        type: "implicit",
        refs: []
      };
    } else if (
      t.isSwitchStatement(node) &&
      node.cases.some(caseNode =>
        caseNode.consequent.some(child => isLexicalVariable(child))
      )
    ) {
      pushTempScope(state, "block", "Switch", {
        start: fromBabelLocation(node.loc.start, state.sourceId),
        end: fromBabelLocation(node.loc.end, state.sourceId)
      });
    }
  },
  exit(
    node: Node,
    ancestors: TraversalAncestors,
    state: ScopeCollectionVisitorState
  ) {
    const scope = state.scopeStack.pop();
    if (!scope) {
      throw new Error("Assertion failure - unsynchronized pop");
    }

    state.scope = scope;
  }
};

function buildMetaBindings(
  sourceId: SourceId,
  node: BabelNode,
  ancestors: TraversalAncestors,
  parentIndex: number = ancestors.length - 1
): BindingMetaValue | null {
  if (parentIndex <= 1) {
    return null;
  }
  const parent = ancestors[parentIndex].node;
  const grandparent = ancestors[parentIndex - 1].node;

  // Consider "0, foo" to be equivalent to "foo".
  if (
    t.isSequenceExpression(parent) &&
    parent.expressions.length === 2 &&
    t.isNumericLiteral(parent.expressions[0]) &&
    parent.expressions[1] === node
  ) {
    let start = parent.loc.start;
    let end = parent.loc.end;

    if (t.isCallExpression(grandparent, { callee: parent })) {
      // Attempt to expand the range around parentheses, e.g.
      // (0, foo.bar)()
      start = grandparent.loc.start;
      end = Object.assign({}, end);
      end.column += 1;
    }

    return {
      type: "inherit",
      start: fromBabelLocation(start, sourceId),
      end: fromBabelLocation(end, sourceId),
      parent: buildMetaBindings(sourceId, parent, ancestors, parentIndex - 1)
    };
  }

  // Consider "Object(foo)" to be equivalent to "foo"
  if (
    t.isCallExpression(parent) &&
    t.isIdentifier(parent.callee, { name: "Object" }) &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === node
  ) {
    return {
      type: "inherit",
      start: fromBabelLocation(parent.loc.start, sourceId),
      end: fromBabelLocation(parent.loc.end, sourceId),
      parent: buildMetaBindings(sourceId, parent, ancestors, parentIndex - 1)
    };
  }

  if (t.isMemberExpression(parent, { object: node })) {
    if (parent.computed) {
      if (t.isStringLiteral(parent.property)) {
        return {
          type: "member",
          start: fromBabelLocation(parent.loc.start, sourceId),
          end: fromBabelLocation(parent.loc.end, sourceId),
          property: parent.property.value,
          parent: buildMetaBindings(
            sourceId,
            parent,
            ancestors,
            parentIndex - 1
          )
        };
      }
    } else {
      return {
        type: "member",
        start: fromBabelLocation(parent.loc.start, sourceId),
        end: fromBabelLocation(parent.loc.end, sourceId),
        property: parent.property.name,
        parent: buildMetaBindings(sourceId, parent, ancestors, parentIndex - 1)
      };
    }
  }
  if (
    t.isCallExpression(parent, { callee: node }) &&
    parent.arguments.length == 0
  ) {
    return {
      type: "call",
      start: fromBabelLocation(parent.loc.start, sourceId),
      end: fromBabelLocation(parent.loc.end, sourceId),
      parent: buildMetaBindings(sourceId, parent, ancestors, parentIndex - 1)
    };
  }

  return null;
}

function looksLikeCommonJS(rootScope: TempScope): boolean {
  return (
    rootScope.bindings.__dirname.refs.length > 0 ||
    rootScope.bindings.__filename.refs.length > 0 ||
    rootScope.bindings.require.refs.length > 0 ||
    rootScope.bindings.exports.refs.length > 0 ||
    rootScope.bindings.module.refs.length > 0
  );
}

function stripModuleScope(rootScope: TempScope): void {
  const rootLexicalScope = rootScope.children[0];
  const moduleScope = rootLexicalScope.children[0];
  if (moduleScope.type !== "module") {
    throw new Error("Assertion failure - should be module");
  }

  Object.keys(moduleScope.bindings).forEach(name => {
    const binding = moduleScope.bindings[name];
    if (binding.type === "let" || binding.type === "const") {
      rootLexicalScope.bindings[name] = binding;
    } else {
      rootScope.bindings[name] = binding;
    }
  });
  rootLexicalScope.children = moduleScope.children;
  rootLexicalScope.children.forEach(child => {
    child.parent = rootLexicalScope;
  });
}
