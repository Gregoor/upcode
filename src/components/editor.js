// @flow
import React, { PureComponent } from 'react';
import ReactDOM from 'react-dom';
import styled from 'styled-components';
import generate from 'babel-generator';
import {
  arrayExpression,
  booleanLiteral,
  isArrayExpression,
  isIdentifier,
  isNullLiteral,
  isNumericLiteral,
  isObjectExpression,
  isObjectProperty,
  isStringLiteral,
  nullLiteral,
  numericLiteral,
  objectExpression,
  objectProperty,
  stringLiteral
} from 'babel-types';
import * as Immutable from 'immutable';
import EditorContext from './editor-context';
import keyMappings from '../key-mappings';
import navigate from '../navigate';
import parse, { parseObject } from '../utils/parse';
import styles from '../utils/styles';
import type {
  AST,
  ASTPath,
  Direction,
  EditorContextValue,
  VerticalDirection
} from '../types';
import * as collections from './collections';
import * as declarations from './declarations';
import Keymap from './keymap';
import * as literals from './literals';
import * as misc from './misc';
import ASTNode, { injectASTNodeComponents } from './ast-node';
import type { KeyMapping } from '../key-mappings';

const { List } = Immutable;

const MAX_HISTORY_LENGTH = 100;

function between(number, lower, upper) {
  return number >= lower && number <= upper;
}

function isEditable(node?: AST) {
  return isStringLiteral(node) || isNumericLiteral(node) || isIdentifier(node);
}

injectASTNodeComponents({
  ...collections,
  ...declarations,
  ...literals,
  ...misc
});

const Container = styled.div`
  position: relative;
  display: flex;
  flex-direction: row;
  white-space: pre;
  outline: none;
  ${styles.text};
`;

const Button = styled.button`
  position: absolute;
  right: 0;
`;

const Form = styled.form`
  width: 100%;
  padding: 1px;
  overflow-x: auto;
`;

declare type Props = {
  initiallyShowKeymap: boolean,
  defaultValue: {},
  onChange: (json: string) => any
};

declare type EditorState = {
  +ast: any /*AST*/,
  +selected: ASTPath
};

const SELECTED_PREFIX = List.of('program', 'body');

export default class Editor extends PureComponent<
  Props,
  {
    future: List<EditorState>,
    history: List<EditorState>,
    showKeymap: boolean
  }
> {
  static defaultProps = {
    initiallShowKeymap: true,
    defaultValue: {},
    onChange: () => null
  };

  actions: { [actionType: string]: (actionParam: any) => any };

  contextValue: EditorContextValue;

  constructor(props: Props) {
    super(props);
    const initalEditorState = {
      ast: parse(props.defaultValue),
      selected: SELECTED_PREFIX
    };
    this.state = {
      future: List(),
      history: List([initalEditorState]),
      showKeymap: props.initiallyShowKeymap
    };
    this.contextValue = {
      ...initalEditorState,
      lastDirection: 'DOWN',
      selectedRef: React.createRef(),
      onSelect: this.handleSelect
    };
    this.actions = {
      UNDO: () => this.undo(),
      REDO: () => this.redo(),

      INSERT: () => this.insert(nullLiteral()),
      MOVE: direction => this.moveSelected(direction),
      DELETE: () => this.deleteSelected(),

      SET_BOOLEAN: value => this.replace(booleanLiteral(value)),
      ADD_TO_NUMBER: increment =>
        this.updateValue(value => (parseFloat(value) + increment).toString()),
      CHANGE_DECLARATION_KIND: (kind) => this.changeDeclarationKind(kind),
      TO_STRING: () =>
        this.replace(
          stringLiteral((this.getSelectedNode().value || '').toString())
        ),
      TO_NUMBER: () => {
        const {value} = this.getSelectedNode();
        return this.replace(
          numericLiteral(Number(value) || parseFloat(value) || 0)
        );
      },
      TO_ARRAY: () => this.replace(arrayExpression([this.getSelectedNode()])),
      TO_OBJECT: () =>
        this.replace(
          (Immutable.fromJS(
            objectExpression([
              objectProperty(stringLiteral(''), this.getSelectedNode())
            ])
          ): any),
          List.of('properties', 0, 'key')
        ),
      TO_NULL: () => this.replace(nullLiteral())
    };
  }

  componentDidMount() {
    document.addEventListener('copy', this.handleCopy);
    document.addEventListener('cut', this.handleCut);
    document.addEventListener('paste', this.handlePaste);
  }

  componentWillUnmount() {
    document.removeEventListener('copy', this.handleCopy);
    document.removeEventListener('cut', this.handleCut);
    document.removeEventListener('paste', this.handlePaste);
  }

  toggleShowKeymap = () =>
    this.setState(({ showKeymap }) => ({
      showKeymap: !showKeymap
    }));

  retainFocus = (el: any) => {
    if (el && !isEditable(this.getSelectedNode())) {
      const div = ReactDOM.findDOMNode(el);
      if (div instanceof HTMLElement) {
        div.focus();
      }
    }
  };

  getCurrentEditorState() {
    return ((this.state.history.first(): any): EditorState);
  }

  getSelectedNode() {
    const { ast, selected } = this.getCurrentEditorState();
    const node = ast.getIn(selected);
    return node ? node.toJS() : node;
  }

  getClosestCollectionPath(ast: any /*AST*/, selected: ASTPath) {
    const selectedNode = ast.getIn(selected).toJS();

    if (isObjectExpression(selectedNode)) {
      return selected.push('properties');
    } else if (isArrayExpression(selectedNode)) {
      return selected.push('elements');
    }

    const index = selected.findLastIndex(key =>
      ['elements', 'properties'].includes(key)
    );
    return selected.slice(0, index + 1);
  }

  addToHistory(updateFn: (ast: any /*AST*/, selected: ASTPath) => any) {
    this.setState(({ history }) => {
      let { ast, selected } = history.first() || {};

      if (selected.last() !== 'end' && !ast.getIn(selected)) {
        selected = List();
      }

      const selectedNode = ast.getIn(selected);
      if (selectedNode && isNumericLiteral(selectedNode.toJS())) {
        ast = ast.updateIn(selected.push('value'), value =>
          parseFloat(value).toString()
        );
      }

      const newState = { ast, selected, ...updateFn(ast, selected) };
      const isASTPristine = Immutable.is(ast, newState.ast);

      if (newState.ast && !isASTPristine) {
        this.props.onChange(generate(newState.ast.toJS()).code);
      }
      this.updateEditorStateContext(newState);
      return Immutable.is(selected, newState.selected) && isASTPristine
        ? undefined
        : {
            future: List(),
            history: history.unshift(newState).slice(0, MAX_HISTORY_LENGTH)
          };
    });
  }

  updateValue(updateFn: any => any) {
    this.addToHistory((ast, selected) => ({
      ast: ast.updateIn(selected.push('value'), updateFn)
    }));
  }

  changeDeclarationKind(kind: string) {
    this.addToHistory((ast, selected) => ({
      ast: ast.updateIn(selected.push('kind'), () => kind)
    }));
  }

  insert = (node: any) =>
    this.addToHistory((ast, selected) => {
      const immutableNode = Immutable.fromJS(node);
      const collectionPath = this.getClosestCollectionPath(
        ast,
        selected.last() === 'end' ? selected.slice(0, -3) : selected
      );
      const itemIndex =
        selected.last() === 'end'
          ? collectionPath.size
          : selected.get(collectionPath.size) + 1 || 0;

      const collectionNode = ast.getIn(collectionPath.butLast()).toJS();
      const isArray = isArrayExpression(collectionNode);
      const isObject = isObjectExpression(collectionNode);

      if (!isArray && !isObject) return;

      const newAST = ast.updateIn(collectionPath, list =>
        list.insert(
          itemIndex,
          isArray
            ? immutableNode
            : Immutable.fromJS(objectProperty(stringLiteral(''), node))
        )
      );
      let newSelected = collectionPath.push(itemIndex);
      if (!isArray) newSelected = newSelected.push('key');
      return {
        ast: newAST,
        selected: newSelected
      };
    });

  replace(node: any /*AST*/, subSelected: ASTPath = List.of()) {
    this.addToHistory((ast, selected) => ({
      ast: ast.updateIn(selected, () => Immutable.fromJS(node)),
      selected: selected.concat(subSelected)
    }));
  }

  changeSelected = (
    changeFn: (
      ast: any /*AST*/,
      selected: ASTPath
    ) => { direction?: Direction, selected: ASTPath }
  ) => {
    return this.addToHistory((ast, selected) => {
      const { direction, selected: newSelected } = changeFn(ast, selected);
      this.contextValue = { ...this.contextValue, lastDirection: direction };
      return {
        ast,
        selected: newSelected
      };
    });
  };

  deleteSelected() {
    return this.addToHistory((ast, selected) => {
      const newAST = ast.deleteIn(
        selected.slice(
          0,
          1 + selected.findLastIndex(value => typeof value === 'number')
        )
      );
      const isASTDelete =
        selected.isEmpty() ||
        (selected.size === 2 && selected.last() === 'end');
      return {
        ast: isASTDelete ? Immutable.fromJS(nullLiteral()) : newAST,
        selected:
          isASTDelete || selected.last() === 'end'
            ? List()
            : navigate('DOWN', newAST, navigate('UP', ast, selected))
      };
    });
  }

  moveSelected = (direction: VerticalDirection) =>
    this.addToHistory((ast, selected) => {
      const isMoveUp = direction === 'UP';

      const collectionPath = this.getClosestCollectionPath(ast, selected);

      const itemIndex =
        selected.last() === 'end'
          ? collectionPath.size
          : selected.get(collectionPath.size) || 0;
      const itemPath = collectionPath.push(itemIndex);
      const item = ast.getIn(itemPath);
      const isItemObjectProperty = isObjectProperty(item);

      const newItemIndex = parseInt(itemIndex, 10) + (isMoveUp ? -1 : 1);
      const newItemPath = collectionPath.push(newItemIndex);
      const targetItem = ast.getIn(newItemPath);

      if (
        isItemObjectProperty &&
        isObjectProperty(targetItem) &&
        isObjectExpression(targetItem.value)
      ) {
        const targetObjectPath = newItemPath.push('value', 'properties');
        const targetIndex = isMoveUp ? ast.getIn(targetObjectPath).size : 0;
        return {
          ast: ast
            .updateIn(targetObjectPath, collection =>
              collection.insert(targetIndex, item)
            )
            .updateIn(collectionPath, collection =>
              collection.delete(itemIndex)
            ),
          selected: collectionPath
            .push(
              newItemIndex + (isMoveUp ? 0 : -1),
              'value',
              'properties',
              targetIndex
            )
            .concat(selected.slice(collectionPath.size + 1))
        };
      }

      if (newItemIndex < 0 || !targetItem) {
        const collectionIndexPath = newItemPath.slice(0, -3);
        const parentCollectionPath = this.getClosestCollectionPath(
          ast,
          collectionIndexPath
        );

        if (
          !isItemObjectProperty ||
          !isObjectExpression(ast.getIn(parentCollectionPath.butLast()))
        ) {
          return;
        }

        const collectionIndex =
          collectionIndexPath.last() === 'end'
            ? parentCollectionPath.size
            : selected.get(parentCollectionPath.size) || 0;
        const newItemIndex = parseInt(collectionIndex, 10) + (isMoveUp ? 0 : 1);

        return {
          ast: ast
            .updateIn(collectionPath, collection =>
              collection.delete(itemIndex)
            )
            .updateIn(parentCollectionPath, collection =>
              collection.insert(newItemIndex, item)
            ),
          selected: parentCollectionPath
            .push(newItemIndex)
            .concat(selected.slice(itemPath.size))
        };
      }

      return {
        ast: ast
          .updateIn(itemPath, () => targetItem)
          .updateIn(newItemPath, () => item),
        selected: selected.update(collectionPath.size, () => newItemIndex)
      };
    });

  undo() {
    this.setState(({ future, history }) => {
      const newHistory = history.size > 1 ? history.shift() : history;
      this.updateEditorStateContext((newHistory.first(): any));
      return {
        future: future.unshift((history.first(): any)),
        history: newHistory
      };
    });
  }

  redo() {
    this.setState(({ future, history }) => {
      const newHistory = future.isEmpty()
        ? history
        : history.unshift((future.first(): any));
      this.updateEditorStateContext((newHistory.first(): any));
      return {
        future: future.shift(),
        history: newHistory
      };
    });
  }

  handleCopy = (event: any) => {
    if (isEditable(this.getSelectedNode())) {
      return;
    }

    let { ast, selected } = this.getCurrentEditorState();
    if (selected.last() === 'end') {
      selected = selected.slice(0, -2);
    }
    event.clipboardData.setData(
      'text/plain',
      generate(ast.getIn(selected).toJS()).code
    );
    event.preventDefault();
  };

  handleCut = (event: any) => {
    if (isEditable(this.getSelectedNode())) {
      return;
    }

    this.handleCopy(event);
    this.deleteSelected();
  };

  handlePaste = (event: any) => {
    if (isEditable(this.getSelectedNode())) {
      return;
    }

    const clipboardStr = event.clipboardData.getData('text/plain');
    let data;
    try {
      data = JSON.parse(clipboardStr);
    } catch (e) {
      console.error(e);
      return;
    }
    event.preventDefault();
    this.insert(parseObject(data));
  };

  handleKeyDown = (event: any) => {
    const { selected } = this.getCurrentEditorState();
    const selectedNode = this.getSelectedNode();

    const direction = {
      ArrowUp: 'UP',
      ArrowDown: 'DOWN',
      ArrowLeft: 'LEFT',
      ArrowRight: 'RIGHT'
    }[event.key];
    const selectedInput = this.contextValue.selectedRef.current;

    if (
      !event.altKey &&
      direction &&
      (direction === 'UP' ||
        direction === 'DOWN' ||
        !isEditable(selectedNode) ||
        !selectedInput ||
        !between(
          selectedInput.selectionStart + (direction === 'LEFT' ? -1 : 1),
          0,
          selectedInput.value.length
        ))
    ) {
      event.preventDefault();
      return this.changeSelected((ast, selected) => ({
        direction,
        selected: navigate(direction, ast, selected)
      }));
    }

    const enteredNumber = parseInt(event.key, 10);
    if (isNullLiteral(selectedNode) && !isNaN(enteredNumber)) {
      event.preventDefault();
      return this.replace(numericLiteral(enteredNumber));
    }

    function findActionFor(keyMappings: KeyMapping[], event: any) {
      for (const { mappings, name, keys, modifiers, test, type } of keyMappings) {
        if (
          (modifiers &&
            (Array.isArray(modifiers)
              ? modifiers
              : modifiers(selectedNode, selected)
            ).some(modifier => !event[modifier + 'Key'])) ||
          (keys && keys.every(key => key !== event.key)) ||
          (test && !test(selectedNode, selected))
        ) {
          continue;
        }

        if (!mappings) return [type];
        const action = findActionFor(mappings, event);
        if (!(type || name) || action) return type ? [type, ...action] : action;
      }
    }
    const [actionName, actionParam] = findActionFor(keyMappings, event) || [];
    if (actionName) {
      event.preventDefault();
      if (!this.actions[actionName]) {
        console.error('Missing action', actionName);
        return;
      }
      this.actions[actionName](actionParam);
    }
  };

  handleChange = ({ target: { value } }: any) => {
    this.addToHistory((ast, selected) => ({
      ast: ast.setIn(
        selected.push(selected.last() === 'id' ? 'name' : 'value'),
        value
      )
    }));
  };

  handleSelect = (selected: ASTPath) =>
    this.changeSelected(() => ({ selected }));

  updateEditorStateContext = (newEditorState: EditorState) => {
    this.contextValue = {
      ...this.contextValue,
      ...newEditorState
    };
  };

  render() {
    const { showKeymap } = this.state;
    const { selected } = this.getCurrentEditorState();
    const isInArray =
      (selected.last() === 'end'
        ? selected.slice(0, -2)
        : selected
      ).findLast(key => ['elements', 'properties'].includes(key)) ===
      'elements';
    return (
      <Container
        tabIndex="0"
        ref={el => this.retainFocus(el)}
        onKeyDown={this.handleKeyDown}
      >
        {window.location.host.startsWith('localhost') && (
          <div style={{ position: 'fixed', top: 0, left: 0 }}>
            {
              (selected
                .toJS()
                .map((s, i, arr) => [s, i + 1 < arr.length && ' > ']): any)
            }
          </div>
        )}

        <Button type="button" onClick={this.toggleShowKeymap}>
          {showKeymap ? 'x' : '?'}
        </Button>
        <Form onChange={this.handleChange} style={{ marginRight: 10 }}>
          <EditorContext.Provider value={this.contextValue}>
            <ASTNode level={0} path={List()} />
          </EditorContext.Provider>
        </Form>
        {showKeymap && (
          <Keymap
            {...{ isInArray, selected }}
            selectedNode={this.getSelectedNode()}
          />
        )}
      </Container>
    );
  }

  reset = () => {
    this.addToHistory(() => ({
      ast: parse(this.props.defaultValue),
      selected: List()
    }));
  };
}
