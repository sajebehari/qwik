import { isDev } from '@builder.io/qwik/build';
import { type OnRenderFn } from '../../component/component.public';
import { SERIALIZABLE_STATE } from '../../container/serializers';
import { assertDefined, assertFalse, assertTrue } from '../../error/assert';
import type { QRLInternal } from '../../qrl/qrl-class';
import type { QRL } from '../../qrl/qrl.public';
import { dangerouslySetInnerHTML, serializeAttribute } from '../../render/execute-component';
import { Fragment, JSXNodeImpl, isJSXNode } from '../../render/jsx/jsx-runtime';
import { Slot } from '../../render/jsx/slot.public';
import type { JSXNode, JSXOutput } from '../../render/jsx/types/jsx-node';
import type { JSXChildren } from '../../render/jsx/types/jsx-qwik-attributes';
import { SubscriptionType } from '../../state/common';
import { isSignal } from '../../state/signal';
import { trackSignal } from '../../use/use-core';
import { destroyTask, isTask, type SubscriberEffect } from '../../use/use-task';
import { EMPTY_OBJ } from '../../util/flyweight';
import { throwErrorAndStop } from '../../util/log';
import {
  ELEMENT_KEY,
  ELEMENT_PROPS,
  ELEMENT_SEQ,
  OnRenderProp,
  QSlot,
  QSlotParent,
  QStyle,
  QUnclaimedProjections,
} from '../../util/markers';
import { isPromise } from '../../util/promises';
import { type ValueOrPromise } from '../../util/types';
import { executeComponent2 } from '../shared/component-execution';
import {
  convertEventNameFromJsxPropToHtmlAttr,
  getEventNameFromJsxProp,
  getEventNameScopeFromJsxProp,
  isHtmlAttributeAnEventName,
  isJsxPropertyAnEventName,
} from '../shared/event-names';
import { ChoreType } from '../shared/scheduler';
import { hasClassAttr } from '../shared/scoped-styles';
import type { QElement2, QwikLoaderEventScope, fixMeAny } from '../shared/types';
import { DEBUG_TYPE, VirtualType } from '../shared/types';
import type { DomContainer } from './dom-container';
import {
  ElementVNodeProps,
  VNodeFlags,
  VNodeProps,
  VirtualVNodeProps,
  type ClientAttrKey,
  type ClientAttrs,
  type ClientContainer,
  type ElementVNode,
  type TextVNode,
  type VNode,
  type VirtualVNode,
} from './types';
import {
  mapApp_findIndx,
  mapApp_remove,
  mapArray_set,
  vnode_ensureElementInflated,
  vnode_getAttr,
  vnode_getElementName,
  vnode_getFirstChild,
  vnode_getNextSibling,
  vnode_getNode,
  vnode_getParent,
  vnode_getProjectionParentComponent,
  vnode_getProp,
  vnode_getPropStartIndex,
  vnode_getText,
  vnode_getType,
  vnode_insertBefore,
  vnode_isElementVNode,
  vnode_isTextVNode,
  vnode_isVNode,
  vnode_isVirtualVNode,
  vnode_locate,
  vnode_newElement,
  vnode_newText,
  vnode_newVirtual,
  vnode_remove,
  vnode_setAttr,
  vnode_setProp,
  vnode_setText,
  vnode_truncate,
  type VNodeJournal,
} from './vnode';

export type ComponentQueue = Array<VNode>;

export const vnode_diff = (
  container: ClientContainer,
  jsxNode: JSXOutput,
  vStartNode: VNode,
  scopedStyleIdPrefix: string | null
) => {
  const journal = (container as DomContainer).$journal$;

  /**
   * Stack is used to keep track of the state of the traversal.
   *
   * We push current state into the stack before descending into the child, and we pop the state
   * when we are done with the child.
   */
  const stack: any[] = [];

  const asyncQueue: Array<VNode | ValueOrPromise<JSXOutput>> = [];

  ////////////////////////////////
  //// Traverse state variables
  ////////////////////////////////
  let vParent: VNode = null!;

  /// Current node we compare against. (Think of it as a cursor.)
  /// (Node can be null, if we are at the end of the list.)
  let vCurrent: VNode | null = null;

  /// When we insert new node we start it here so that we can descend into it.
  /// NOTE: it can't be stored in `vCurrent` because `vNewCurrent` is in journal
  /// and is not connected to the tree.
  let vNewNode: VNode | null = null; // TODO: delete, because journal is on vNode, the above comment no longer applies

  /// When elements have keys they can be consumed out of order and therefore we can't use nextSibling.
  /// In such a case this array will contain the elements after the current location.
  /// The array even indices will contains keys and odd indices the vNode.
  let vSiblings: Array<string | null | VNode> | null = null;
  let vSiblingsIdx = -1;

  /// Current set of JSX children.
  let jsxChildren: any[] = null!;
  // Current JSX child.
  let jsxValue: any = null;
  let jsxIdx = 0;
  let jsxCount = 0;

  // When we descend into children, we need to skip advance() because we just descended.
  let shouldAdvance = true;

  /**
   * When we are rendering inside a projection we don't want to process child components. Child
   * components will be processed only if the projection is re-projected with a `<Slot>`.
   *
   * Example: <Parent> <div> <Child/> </div> </Parent>
   *
   * In the above example, the `Child` component will not be processed because it is inside a
   * projection. Only if the `<Parent>` projects its content with `<Slot>` will the `Child`
   * component be processed.
   */
  // let inContentProjection = false;
  ////////////////////////////////

  diff(jsxNode, vStartNode);
  return drainAsyncQueue();

  //////////////////////////////////////////////
  //////////////////////////////////////////////
  //////////////////////////////////////////////

  function diff(jsxNode: JSXOutput, vStartNode: VNode) {
    assertFalse(vnode_isVNode(jsxNode), 'JSXNode should not be a VNode');
    assertTrue(vnode_isVNode(vStartNode), 'vStartNode should be a VNode');
    vParent = vStartNode;
    vNewNode = null;
    vCurrent = vnode_getFirstChild(vStartNode);
    stackPush(jsxNode, true);
    while (stack.length) {
      while (jsxIdx < jsxCount) {
        assertFalse(vParent === vCurrent, "Parent and current can't be the same");
        if (typeof jsxValue === 'string') {
          expectText(jsxValue);
        } else if (typeof jsxValue === 'number') {
          expectText(String(jsxValue));
        } else if (jsxValue && typeof jsxValue === 'object') {
          if (Array.isArray(jsxValue)) {
            descend(jsxValue, false);
          } else if (isSignal(jsxValue)) {
            expectVirtual(VirtualType.DerivedSignal, null);
            descend(
              trackSignal(jsxValue, [
                SubscriptionType.TEXT_MUTABLE,
                vCurrent || (vNewNode as fixMeAny), // This should be host, but not sure why
                jsxValue,
                vCurrent || (vNewNode as fixMeAny),
              ]),
              true
            );
          } else if (isPromise(jsxValue)) {
            expectVirtual(VirtualType.Awaited, null);
            asyncQueue.push(jsxValue, vNewNode || vCurrent);
          } else if (isJSXNode(jsxValue)) {
            const type = jsxValue.type;
            if (typeof type === 'string') {
              expectNoMoreTextNodes();
              expectElement(jsxValue, type);
              descend(jsxValue.children, true);
            } else if (typeof type === 'function') {
              if (type === Fragment) {
                expectNoMoreTextNodes();
                expectVirtual(VirtualType.Fragment, jsxValue.key);
                descend(jsxValue.children, true);
              } else if (type === Slot) {
                expectNoMoreTextNodes();
                if (!expectSlot()) {
                  // nothing to project, so try to render the Slot default content.
                  descend(jsxValue.children, true);
                }
              } else if (type === Projection) {
                expectProjection();
                descend(jsxValue.children, true);
              } else {
                // Must be a component
                expectNoMoreTextNodes();
                expectComponent(type);
              }
            } else {
              throwErrorAndStop(`Unsupported type: ${type}`);
            }
          } else {
            throwErrorAndStop(`Unsupported value: ${jsxValue}`);
          }
        } else {
          expectText('');
        }
        advance();
      }
      expectNoMore();
      ascend();
    }
  }

  function advance() {
    if (!shouldAdvance) {
      shouldAdvance = true;
      return;
    }
    jsxIdx++;
    if (jsxIdx < jsxCount) {
      jsxValue = jsxChildren[jsxIdx];
    } else if (stack[stack.length - 1] === false) {
      // this was special `descendVNode === false` so pop and try again
      return ascend();
    }
    if (vNewNode !== null) {
      // We have a new Node.
      // This means that the `vCurrent` was deemed not useful and we inserted in front of it.
      // This means that the next node we should look at is the `vCurrent` so just clear the
      // vNewNode  and try again.
      vNewNode = null;
    } else if (vSiblings !== null) {
      // We came across a key, and we moved nodes around. This means we can no longer use
      // `vnode_getNextSibling` to look at next node and instead we have to go by `vSiblings`.
      vSiblingsIdx += 2; // advance;
      vCurrent = vSiblingsIdx < vSiblings.length ? (vSiblings[vSiblingsIdx + 1] as any) : null;
    } else {
      // If we don't have a `vNewNode`, than that means we just reconciled the current node.
      // So advance it.
      vCurrent = vCurrent ? vnode_getNextSibling(vCurrent) : null;
    }
  }

  /**
   * @param children
   * @param descendVNode - If true we are descending into vNode; This is set to false if we come
   *   across an array in jsx, and we need to descend into the array without actually descending
   *   into the vNode.
   *
   *   Example:
   *
   *   ```
   *   <>
   *   before
   *   {[1,2].map((i) => <span>{i}</span>)}
   *   after
   *   </>
   * ```
   *
   *   In the above example all nodes are on same level so we don't `descendVNode` even thought there
   *   is an array produced by the `map` function.
   */
  function descend(children: any, descendVNode: boolean) {
    if (children == null) {
      expectNoChildren();
      return;
    }
    stackPush(children, descendVNode);
    if (descendVNode) {
      assertDefined(vCurrent || vNewNode, 'Expecting vCurrent to be defined.');
      vSiblings = null;
      vSiblingsIdx = -1;
      vParent = vNewNode || vCurrent!;
      vCurrent = vnode_getFirstChild(vParent);
      vNewNode = null;
    }
    shouldAdvance = false;
  }

  function ascend() {
    const descendVNode = stack.pop(); // boolean: descendVNode
    if (descendVNode) {
      vSiblingsIdx = stack.pop();
      vSiblings = stack.pop();
      vNewNode = stack.pop();
      vCurrent = stack.pop();
      vParent = stack.pop();
    }
    jsxValue = stack.pop();
    jsxCount = stack.pop();
    jsxIdx = stack.pop();
    jsxChildren = stack.pop();
    advance();
  }

  function stackPush(children: any, descendVNode: boolean) {
    stack.push(jsxChildren, jsxIdx, jsxCount, jsxValue);
    if (descendVNode) {
      stack.push(vParent, vCurrent, vNewNode, vSiblings, vSiblingsIdx);
    }
    stack.push(descendVNode);
    if (Array.isArray(children)) {
      jsxIdx = 0;
      jsxCount = children.length;
      jsxChildren = children;
      jsxValue = jsxCount > 0 ? children[0] : null;
    } else if (children === undefined) {
      // no children
      jsxIdx = 0;
      jsxValue = null;
      jsxChildren = null!;
      jsxCount = 0;
    } else {
      jsxIdx = 0;
      jsxValue = children;
      jsxChildren = null!;
      jsxCount = 1;
    }
  }

  function getInsertBefore() {
    if (vNewNode) {
      return vCurrent;
    } else if (vSiblings !== null) {
      const nextIdx = vSiblingsIdx + 3; // 2 plus 1 for node offset
      return nextIdx < vSiblings.length ? (vSiblings[nextIdx] as VNode) : null;
    } else {
      return vCurrent && vnode_getNextSibling(vCurrent);
    }
  }

  /////////////////////////////////////////////////////////////////////////////
  /////////////////////////////////////////////////////////////////////////////
  /////////////////////////////////////////////////////////////////////////////

  function descendContentToProject(children: JSXChildren) {
    if (children == null) {
      return;
    }
    if (!Array.isArray(children)) {
      children = [children];
    }
    if (children.length) {
      const projections: Array<string | JSXNode> = [];
      /// STEP 1: Bucketize the children based on the projection name.
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const slotName = String((isJSXNode(child) && child.props[QSlot]) || '');
        const idx = mapApp_findIndx(projections, slotName, 0);
        let jsxBucket: JSXNodeImpl<typeof Projection>;
        if (idx >= 0) {
          jsxBucket = projections[idx + 1] as any;
        } else {
          projections.splice(
            ~idx,
            0,
            slotName,
            (jsxBucket = new JSXNodeImpl(Projection, EMPTY_OBJ, null, [], 0, slotName))
          );
        }
        (jsxBucket.children as JSXChildren[]).push(child);
      }
      /// STEP 2: remove the names
      for (let i = projections.length - 2; i >= 0; i = i - 2) {
        projections.splice(i, 1);
      }
      descend(projections, true);
    }
  }

  function expectProjection() {
    const slotName = jsxValue.key as string;
    // console.log('expectProjection', JSON.stringify(slotName));
    vCurrent = vnode_getProp<VirtualVNode | null>(
      vParent, // The parent is the component and it should have our portal.
      slotName,
      (id) => vnode_locate(container.rootVNode, id)
    );
    if (vCurrent == null) {
      vNewNode = vnode_newVirtual();
      isDev && vnode_setProp(vNewNode, DEBUG_TYPE, VirtualType.Projection);
      isDev && vnode_setProp(vNewNode, 'q:code', 'expectProjection');
      vnode_setProp(vNewNode as VirtualVNode, QSlot, slotName);
      vnode_setProp(vNewNode as VirtualVNode, QSlotParent, vParent);
      vnode_setProp(vParent as VirtualVNode, slotName, vNewNode);

      const componentProjections =
        vnode_getProp<(string | VNode)[]>(vParent, QUnclaimedProjections, null) || [];
      mapArray_set(componentProjections, slotName, vNewNode, 0);
      vnode_setProp(vParent as VirtualVNode, QUnclaimedProjections, componentProjections);
    }
  }

  function expectSlot() {
    const slotNameKey: string = jsxValue.props.name || '';
    // console.log('expectSlot', JSON.stringify(slotNameKey));
    const vHost = vnode_getProjectionParentComponent(vParent, container.$getObjectById$);

    if (vHost) {
      const componentProjections =
        vnode_getProp<(string | JSXChildren | number)[]>(vHost, QUnclaimedProjections, null) || [];
      mapApp_remove(componentProjections, slotNameKey, 0);
      vnode_setProp(vHost, QUnclaimedProjections, componentProjections);
    }

    const vProjectedNode = vHost
      ? vnode_getProp<VirtualVNode | null>(
          vHost,
          slotNameKey,
          // for slots this id is vnode ref id
          null // Projections should have been resolved through container.ensureProjectionResolved
          //(id) => vnode_locate(container.rootVNode, id)
        )
      : null;
    // console.log('   ', String(vHost), String(vProjectedNode));
    if (vProjectedNode == null) {
      // Nothing to project, so render content of the slot.
      vnode_insertBefore(
        journal,
        vParent as ElementVNode | VirtualVNode,
        (vNewNode = vnode_newVirtual()),
        vCurrent && getInsertBefore()
      );
      vnode_setProp(vNewNode, QSlot, slotNameKey);
      vHost && vnode_setProp(vHost, slotNameKey, vNewNode);
      isDev && vnode_setProp(vNewNode, DEBUG_TYPE, VirtualType.Projection);
      isDev && vnode_setProp(vNewNode, 'q:code', 'expectSlot' + count++);
      return false;
    } else if (vProjectedNode === vCurrent) {
      // All is good.
      // console.log('  NOOP', String(vCurrent));
    } else {
      // move from q:template to the target node
      vnode_insertBefore(
        journal,
        vParent as ElementVNode | VirtualVNode,
        (vNewNode = vProjectedNode),
        vCurrent && getInsertBefore()
      );
      vnode_setProp(vNewNode, QSlot, slotNameKey);
      vHost && vnode_setProp(vHost, slotNameKey, vNewNode);
      isDev && vnode_setProp(vNewNode, DEBUG_TYPE, VirtualType.Projection);
      isDev && vnode_setProp(vNewNode, 'q:code', 'expectSlot' + count++);
    }
    return true;
  }

  function drainAsyncQueue(): ValueOrPromise<void> {
    while (asyncQueue.length) {
      const jsxNode = asyncQueue.shift() as ValueOrPromise<JSXNode>;
      const vHostNode = asyncQueue.shift() as VNode;
      if (isPromise(jsxNode)) {
        return jsxNode.then((jsxNode) => {
          diff(jsxNode, vHostNode);
          return drainAsyncQueue();
        });
      } else {
        diff(jsxNode, vHostNode);
      }
    }
  }

  function expectNoChildren() {
    let vChild = vCurrent && vnode_getFirstChild(vCurrent);
    if (vChild !== null) {
      vnode_truncate(journal, vCurrent as ElementVNode | VirtualVNode, vChild);
      while (vChild) {
        cleanup(container, vChild);
        vChild = vnode_getNextSibling(vChild);
      }
    }
  }

  /** Expect no more nodes - Any nodes which are still at cursor, need to be removed. */
  function expectNoMore() {
    assertFalse(vParent === vCurrent, "Parent and current can't be the same");
    if (vCurrent !== null) {
      let vCleanup: VNode | null = vCurrent;
      while (vCleanup) {
        cleanup(container, vCleanup);
        const next = vnode_getNextSibling(vCleanup);
        if (
          vCleanup[VNodeProps.flags] & VNodeFlags.Virtual &&
          vnode_getProp(vCleanup as VirtualVNode, QSlot, null) !== null
        ) {
          // move projected node to the q:template on remove
          vnode_insertBefore(journal, container.qTemplate, vCleanup, null);
        } else {
          vnode_remove(journal, vParent as ElementVNode | VirtualVNode, vCleanup, true);
        }

        vCleanup = next;
      }
    }
  }

  function expectNoMoreTextNodes() {
    while (vCurrent !== null && vnode_getType(vCurrent) === 3 /* Text */) {
      cleanup(container, vCurrent);
      const next = vnode_getNextSibling(vCurrent);
      vnode_remove(journal, vParent, vCurrent, true);
      vCurrent = next;
    }
  }

  /** @param tag Returns true if `qDispatchEvent` needs patching */
  function createNewElement(jsx: JSXNode, tag: string): boolean {
    const element = container.document.createElement(tag);
    vnode_insertBefore(
      journal,
      vParent as ElementVNode,
      (vNewNode = vnode_newElement(element, tag)),
      vCurrent
    );
    const { constProps } = jsx;
    let needsQDispatchEventPatch = false;
    if (constProps) {
      // Const props are, well, constant, they will never change!
      // For this reason we can cheat and write them directly into the DOM.
      // We never tell the vNode about them saving us time and memory.
      for (const key in constProps) {
        let value = constProps[key];
        if (isJsxPropertyAnEventName(key)) {
          // So for event handlers we must add them to the vNode so that qwikloader can look them up
          // But we need to mark them so that they don't get pulled into the diff.
          const eventName = getEventNameFromJsxProp(key);
          const scope = getEventNameScopeFromJsxProp(key);
          vnode_setProp(vNewNode, HANDLER_PREFIX + ':' + scope + ':' + eventName, value);
          needsQDispatchEventPatch = true;
          continue;
        }
        if (isSignal(value)) {
          value = trackSignal(value, [
            SubscriptionType.PROP_IMMUTABLE,
            vNewNode as fixMeAny,
            value,
            vNewNode as fixMeAny,
            key,
            scopedStyleIdPrefix || undefined,
          ]);
        }

        if (key === dangerouslySetInnerHTML) {
          element.innerHTML = value as string;
          continue;
        }

        value = serializeAttribute(key, value, scopedStyleIdPrefix);
        if (value != null) {
          element.setAttribute(key, String(value));
        }
      }
    }
    const key = jsx.key;
    if (key) {
      element.setAttribute(ELEMENT_KEY, key);
      vnode_setProp(vNewNode, ELEMENT_KEY, key);
    }

    // append class attribute if styleScopedId exists and there is no class attribute
    const classAttributeExists =
      hasClassAttr(jsx.varProps) || (jsx.constProps && hasClassAttr(jsx.constProps));
    if (!classAttributeExists && scopedStyleIdPrefix) {
      element.setAttribute('class', scopedStyleIdPrefix);
    }

    return needsQDispatchEventPatch;
  }

  function expectElement(jsx: JSXNode, tag: string) {
    const isSameTagName =
      vCurrent && vnode_isElementVNode(vCurrent) && tag === vnode_getElementName(vCurrent);
    let jsxKey: string | null = null;
    let needsQDispatchEventPatch = false;
    if (
      isSameTagName &&
      (jsxKey = jsx.key) == vnode_getProp(vCurrent as ElementVNode, ELEMENT_KEY, null)
    ) {
      // All is good.
    } else if (jsxKey !== null) {
      // So we have a key and it does not match the current node.
      // We need to do a forward search to find it.
      // The complication is that once we start taking nodes out of order we can't use `vnode_getNextSibling`
      vNewNode = retrieveChildWithKey(jsxKey);
      if (vNewNode === null) {
        // No existing node with key exists, just create a new one.
        needsQDispatchEventPatch = createNewElement(jsx, tag);
      } else {
        // Existing keyed node
        vnode_insertBefore(journal, vParent as ElementVNode, vNewNode, vCurrent);
      }
    } else {
      needsQDispatchEventPatch = createNewElement(jsx, tag);
    }
    // reconcile attributes

    const jsxAttrs = [] as ClientAttrs;
    const props = jsx.varProps;
    for (const key in props) {
      let value = props[key];
      value = serializeAttribute(key, value, scopedStyleIdPrefix);
      if (value != null) {
        mapArray_set(jsxAttrs, key, value, 0);
      }
    }
    if (jsxKey !== null) {
      mapArray_set(jsxAttrs, ELEMENT_KEY, jsxKey, 0);
    }
    const vNode = (vNewNode || vCurrent) as ElementVNode;
    needsQDispatchEventPatch = setBulkProps(vNode, jsxAttrs) || needsQDispatchEventPatch;
    if (needsQDispatchEventPatch) {
      // Event handler needs to be patched onto the element.
      const element = vnode_getNode(vNode) as QElement2;
      if (!element.qDispatchEvent) {
        element.qDispatchEvent = (event: Event, scope: QwikLoaderEventScope) => {
          const eventName = event.type;
          const eventProp = ':' + scope.substring(1) + ':' + eventName;
          const qrls = [
            vnode_getProp<QRL>(vNode, eventProp, null),
            vnode_getProp<QRL>(vNode, HANDLER_PREFIX + eventProp, null),
          ];
          let returnValue = false;
          qrls.flat(2).forEach((qrl) => {
            if (qrl) {
              const value = qrl(event, element) as any;
              returnValue = returnValue || value === true;
            }
          });
          return returnValue;
        };
      }
    }
  }

  /** @param tag Returns true if `qDispatchEvent` needs patching */
  function setBulkProps(vnode: ElementVNode, srcAttrs: ClientAttrs): boolean {
    vnode_ensureElementInflated(vnode);
    const dstAttrs = vnode as ClientAttrs;
    let srcIdx = 0;
    const srcLength = srcAttrs.length;
    let dstIdx = ElementVNodeProps.PROPS_OFFSET;
    let dstLength = dstAttrs.length;
    let srcKey: ClientAttrKey | null = srcIdx < srcLength ? srcAttrs[srcIdx++] : null;
    let dstKey: ClientAttrKey | null = dstIdx < dstLength ? dstAttrs[dstIdx++] : null;
    let patchEventDispatch = false;

    const record = (key: string, value: any) => {
      if (key.startsWith(':')) {
        vnode_setProp(vnode, key, value);
        return;
      }
      if (key === 'ref') {
        value.value = vnode_getNode(vnode);
        return;
      }
      vnode_setAttr(journal, vnode, key, value);
      if (value === null) {
        // if we set `null` than attribute was removed and we need to shorten the dstLength
        dstLength = dstAttrs.length;
      }
    };

    const recordJsxEvent = (key: string, value: any) => {
      const eventName = getEventNameFromJsxProp(key);
      if (eventName) {
        const scope = getEventNameScopeFromJsxProp(key);
        record(':' + scope + ':' + eventName, value);
      }

      // add an event attr with empty value for qwikloader element selector.
      // We don't need value here. For ssr this value is a QRL,
      // but for CSR value should be just empty
      const htmlEvent = convertEventNameFromJsxPropToHtmlAttr(key);
      if (htmlEvent) {
        record(htmlEvent, '');
      }

      // register an event for qwik loader
      ((globalThis as fixMeAny).qwikevents ||= []).push(eventName);
    };

    while (srcKey !== null || dstKey !== null) {
      if (dstKey?.startsWith(HANDLER_PREFIX) || dstKey == ELEMENT_KEY) {
        // These are a special keys which we use to mark the event handlers as immutable or
        // element key we need to ignore them.
        dstIdx++; // skip the destination value, we don't care about it.
        dstKey = dstIdx < dstLength ? dstAttrs[dstIdx++] : null;
      } else if (srcKey == null) {
        // Source has more keys, so we need to remove them from destination
        if (dstKey && isHtmlAttributeAnEventName(dstKey)) {
          patchEventDispatch = true;
        } else {
          record(dstKey!, null);
        }
        dstIdx++; // skip the destination value, we don't care about it.
        dstKey = dstIdx < dstLength ? dstAttrs[dstIdx++] : null;
      } else if (dstKey == null) {
        // Destination has more keys, so we need to insert them from source.
        const isEvent = isJsxPropertyAnEventName(srcKey);
        if (isEvent) {
          // Special handling for events
          patchEventDispatch = true;
          recordJsxEvent(srcKey, srcAttrs[srcIdx]);
        } else {
          record(srcKey!, srcAttrs[srcIdx]);
        }
        srcIdx++;
        srcKey = srcIdx < srcLength ? srcAttrs[srcIdx++] : null;
      } else if (srcKey == dstKey) {
        const srcValue = srcAttrs[srcIdx++];
        const dstValue = dstAttrs[dstIdx++];
        if (srcValue !== dstValue) {
          record(dstKey, srcValue);
        }
        srcKey = srcIdx < srcLength ? srcAttrs[srcIdx++] : null;
        dstKey = dstIdx < dstLength ? dstAttrs[dstIdx++] : null;
      } else if (srcKey < dstKey) {
        // Destination is missing the key, so we need to insert it.
        if (isJsxPropertyAnEventName(srcKey)) {
          // Special handling for events
          patchEventDispatch = true;
          recordJsxEvent(srcKey, srcAttrs[srcIdx]);
        } else {
          record(srcKey, srcAttrs[srcIdx]);
        }
        srcIdx++;
        // advance srcValue
        srcKey = srcIdx < srcLength ? srcAttrs[srcIdx++] : null;
      } else {
        // Source is missing the key, so we need to remove it from destination.
        if (isHtmlAttributeAnEventName(dstKey)) {
          patchEventDispatch = true;
        } else {
          record(dstKey!, null);
        }
        dstIdx++; // skip the destination value, we don't care about it.
        dstKey = dstIdx < dstLength ? dstAttrs[dstIdx++] : null;
      }
    }
    return patchEventDispatch;
  }

  /**
   * Retrieve the child with the given key.
   *
   * By retrieving the child with the given key we are effectively removing it from the list of
   * future elements. This means that we can't just use `vnode_getNextSibling` to find the next
   * instead we have to keep track of the elements we have already seen.
   *
   * We call this materializing the elements.
   *
   * `vSiblingsIdx`:
   *
   * - -1: Not materialized
   * - Positive number - the index of the next element in the `vSiblings` array.
   *
   * By retrieving the child with the given key we are effectively removing it from the list (hence
   * we need to splice the `vSiblings` array).
   *
   * @param key
   * @returns
   */
  function retrieveChildWithKey(key: string): ElementVNode | VirtualVNode | null {
    let vNodeWithKey: ElementVNode | VirtualVNode | null = null;
    if (vSiblingsIdx === -1) {
      // it is not materialized; so materialize it.
      vSiblings = [];
      vSiblingsIdx = 0;
      let vNode = vCurrent;
      while (vNode) {
        const vKey = getKey(vNode, container.$getObjectById$);
        if (vNodeWithKey === null && vKey == key) {
          vNodeWithKey = vNode as ElementVNode | VirtualVNode;
        } else {
          // we only add the elements which we did not find yet.
          vSiblings.push(vKey, vNode);
        }
        vNode = vnode_getNextSibling(vNode);
      }
    } else {
      for (let idx = vSiblingsIdx; idx < vSiblings!.length; idx += 2) {
        const vKey = vSiblings![idx];
        if (vKey == key) {
          vNodeWithKey = vSiblings![idx + 1] as any;
          // remove the node from the siblings array
          vSiblings?.splice(idx, 2);
          break;
        }
      }
    }
    return vNodeWithKey;
  }

  function expectVirtual(type: VirtualType, jsxKey: string | null) {
    if (
      vCurrent &&
      vnode_isVirtualVNode(vCurrent) &&
      vnode_getProp(vCurrent, ELEMENT_KEY, null) === jsxKey
    ) {
      // All is good.
      return;
    } else if (jsxKey !== null) {
      // We have a key find it
      vNewNode = retrieveChildWithKey(jsxKey);
      if (vNewNode != null) {
        // We found it, move it up.
        vnode_insertBefore(
          journal,
          vParent as VirtualVNode,
          (vNewNode = vnode_newVirtual()),
          vCurrent && getInsertBefore()
        );
        return;
      }
    }
    // Did not find it, insert a new one.
    vnode_insertBefore(
      journal,
      vParent as VirtualVNode,
      (vNewNode = vnode_newVirtual()),
      vCurrent && getInsertBefore()
    );
    vnode_setProp(vNewNode as VirtualVNode, ELEMENT_KEY, jsxKey);
    isDev && vnode_setProp((vNewNode || vCurrent) as VirtualVNode, DEBUG_TYPE, type);
  }

  function expectComponent(component: Function) {
    // expectVirtual(VirtualType.Component);
    const componentMeta = (component as any)[SERIALIZABLE_STATE] as [QRLInternal<OnRenderFn<any>>];
    let host = (vNewNode || vCurrent) as VirtualVNode;
    const jsxProps = jsxValue.props;
    if (componentMeta) {
      // QComponent
      let shouldRender = false;
      const [componentQRL] = componentMeta;
      const jsxKey = jsxValue.key || componentQRL.$hash$;
      const vNodeKey = getKey(host, container.$getObjectById$);
      if (jsxKey !== vNodeKey) {
        // See if we already have this component later on.
        vNewNode = retrieveChildWithKey(jsxKey);
        if (vNewNode) {
          // We found the component, move it up.
          vnode_insertBefore(journal, vParent as VirtualVNode, vNewNode, vCurrent);
        } else {
          // We did not find the component, create it.
          vnode_insertBefore(
            journal,
            vParent as VirtualVNode,
            (vNewNode = vnode_newVirtual()),
            vCurrent && getInsertBefore()
          );
          isDev && vnode_setProp(vNewNode, DEBUG_TYPE, VirtualType.Component);
          container.setHostProp(vNewNode, OnRenderProp, componentQRL);
          container.setHostProp(vNewNode, ELEMENT_PROPS, jsxProps);
          container.setHostProp(vNewNode, ELEMENT_KEY, jsxKey);

          // rewrite slot props to the new node
          if (host) {
            for (let i = vnode_getPropStartIndex(host); i < host.length; i = i + 2) {
              const prop = host[i] as string;
              if (!prop.startsWith('q:')) {
                const value = host[i + 1];
                container.setHostProp(vNewNode, prop, value);
              }
            }
          }
        }
        host = vNewNode as VirtualVNode;
        shouldRender = true;
      }
      const vNodeProps = vnode_getProp<any>(host, ELEMENT_PROPS, container.$getObjectById$);
      shouldRender = shouldRender || propsDiffer(jsxProps, vNodeProps);
      if (shouldRender) {
        container.$scheduler$(ChoreType.COMPONENT, host, componentQRL, jsxProps);

        if (host) {
          container.addVNodeProjection(host);
        }
      }
      descendContentToProject(jsxValue.children);
    } else {
      // Inline Component
      if (!host) {
        // We did not find the component, create it.
        vnode_insertBefore(
          journal,
          vParent as VirtualVNode,
          (vNewNode = vnode_newVirtual()),
          vCurrent && getInsertBefore()
        );
        host = vNewNode;
      }
      isDev &&
        vnode_setProp(
          (vNewNode || vCurrent) as VirtualVNode,
          DEBUG_TYPE,
          VirtualType.InlineComponent
        );
      let component$Host: VNode = host;
      // Find the closest component host which has `OnRender` prop.
      while (
        component$Host &&
        (vnode_isVirtualVNode(component$Host)
          ? vnode_getProp(component$Host, OnRenderProp, null) === null
          : true)
      ) {
        component$Host = vnode_getParent(component$Host)!;
      }
      const jsxOutput = executeComponent2(
        container,
        host,
        (component$Host || container.rootVNode) as fixMeAny,
        component as OnRenderFn<any>,
        jsxProps
      );
      asyncQueue.push(jsxOutput, host);
      container.addVNodeProjection(host);
    }
  }

  function expectText(text: string) {
    if (vCurrent !== null) {
      const type = vnode_getType(vCurrent);
      if (type === 3 /* Text */) {
        if (text !== vnode_getText(vCurrent as TextVNode)) {
          vnode_setText(journal, vCurrent as TextVNode, text);
          return;
        }
        return;
      }
    }
    vnode_insertBefore(
      journal,
      vParent as VirtualVNode,
      (vNewNode = vnode_newText(container.document.createTextNode(text), text)),
      vCurrent
    );
  }
};

export const isQStyleVNode = (vNode: VNode): boolean => {
  return (
    vnode_isElementVNode(vNode) &&
    vnode_getElementName(vNode) === 'style' &&
    vnode_getAttr(vNode, QStyle) !== null
  );
};

/**
 * Retrieve the key from the VNode.
 *
 * If the VNode does not have a key and it is a QComponent, we fallback to the QRL as the key.
 *
 * @param vNode - VNode to retrieve the key from
 * @param getObject - Function to retrieve the object by id for QComponent QRL
 * @returns Key
 */
function getKey(vNode: VNode | null, getObject: (id: string) => any): string | null {
  if (vNode == null) {
    return null;
  }
  let vKey = vnode_getProp<string>(vNode, ELEMENT_KEY, null);
  if (vKey == null) {
    const qrl = vnode_getProp<QRLInternal>(vNode, OnRenderProp, getObject);
    // If this is a QComponent and it does not have a key, we fallback to the QRL as the key
    if (qrl) {
      vKey = qrl.$hash$;
    }
  }
  return vKey;
}

/**
 * Marker class for JSX projection.
 *
 * Assume you have component like so
 *
 * ```
 * <SomeComponent>
 *   some-text
 *   <span q:slot="name">some more text</span>
 *   more-text
 * </SomeComponent>
 * ```
 *
 * Before the `<SomeCompetent/>` is processed its children are transformed into:
 *
 * ```
 *   <Projection q:slot="">
 *     some-text
 *     more-text
 *   </Projection>
 *   <Projection q:slot="name">
 *     <span q:slot="name">some more text</span>
 *   </Projection>
 * ```
 */
function Projection() {}

function propsDiffer(src: Record<string, any>, dst: Record<string, any>): boolean {
  if (!src || !dst) {
    return true;
  }
  let srcKeys = removeChildrenKey(Object.keys(src));
  let dstKeys = removeChildrenKey(Object.keys(dst));
  if (srcKeys.length !== dstKeys.length) {
    return true;
  }
  srcKeys = srcKeys.sort();
  dstKeys = dstKeys.sort();
  for (let idx = 0; idx < srcKeys.length; idx++) {
    const srcKey = srcKeys[idx];
    const dstKey = dstKeys[idx];
    if (srcKey !== dstKey || src[srcKey] !== dst[dstKey]) {
      return true;
    }
  }
  return false;
}

function removeChildrenKey(keys: string[]): string[] {
  const childrenIdx = keys.indexOf('children');
  if (childrenIdx !== -1) {
    keys.splice(childrenIdx, 1);
  }
  return keys;
}

/**
 * If vnode is removed, it is necessary to release all subscriptions associated with it.
 *
 * This function will traverse the vnode tree in depth-first order and release all subscriptions.
 *
 * The function takes into account:
 *
 * - Projection nodes by not recursing into them.
 * - Component nodes by recursing into the component content nodes (which may be projected).
 */
export function cleanup(container: ClientContainer, vNode: VNode) {
  let vCursor: VNode | null = vNode;
  // Depth first traversal
  if (vnode_isTextVNode(vNode)) {
    // Text nodes don't have subscriptions or children;
    return;
  }
  let vParent: VNode | null = null;
  do {
    const type = vCursor[VNodeProps.flags];
    if (type & VNodeFlags.ELEMENT_OR_VIRTUAL_MASK) {
      // Only elements and virtual nodes need to be traversed for children
      if (type & VNodeFlags.Virtual) {
        // Only virtual nodes have subscriptions
        container.$subsManager$.$clearSub$(vCursor as fixMeAny);
        const seq = container.getHostProp<Array<any>>(vCursor as fixMeAny, ELEMENT_SEQ);
        if (seq) {
          for (let i = 0; i < seq.length; i++) {
            const obj = seq[i];
            if (isTask(obj)) {
              const task = obj as SubscriberEffect;
              container.$subsManager$.$clearSub$(task);
              destroyTask(task);
            }
          }
        }
      }

      const isComponent =
        type & VNodeFlags.Virtual &&
        vnode_getProp(vCursor as VirtualVNode, OnRenderProp, null) !== null;
      if (isComponent) {
        // SPECIAL CASE: If we are a component, we need to descend into the projected content and release the content.
        const attrs = vCursor as ClientAttrs;
        for (let i = VirtualVNodeProps.PROPS_OFFSET; i < vCursor.length; i = i + 2) {
          const key = attrs[i]!;
          if (!key.startsWith(':') && !key.startsWith('q:')) {
            // any prop which does not start with `:` or `q:` is a content-projection prop.
            const value = attrs[i + 1];
            if (value) {
              attrs[i + 1] = null; // prevent infinite loop
              const projection =
                typeof value === 'string'
                  ? vnode_locate(container.rootVNode, value)
                  : (value as unknown as VNode);
              let projectionChild = vnode_getFirstChild(projection);
              while (projectionChild) {
                cleanup(container, projectionChild);
                projectionChild = vnode_getNextSibling(projectionChild);
              }

              cleanupStaleUnclaimedProjection(container.$journal$, projection);
            }
          }
        }
      }

      const isSlot =
        type & VNodeFlags.Virtual && vnode_getProp(vCursor as VirtualVNode, QSlot, null) !== null;
      // Descend into children
      if (!isSlot) {
        // Only if it is not a projection
        const vFirstChild = vnode_getFirstChild(vCursor);
        if (vFirstChild) {
          vCursor = vFirstChild;
          continue;
        }
      }
    }
    // Out of children, go to next sibling
    const vNextSibling = vnode_getNextSibling(vCursor);
    if (vNextSibling) {
      vCursor = vNextSibling;
      continue;
    }
    if (vCursor === vNode) {
      // we are back where we started, we are done.
      return;
    }
    // Out of siblings, go to parent
    vParent = vnode_getParent(vCursor);
    while (vParent) {
      if (vParent === vNode) {
        // We are back where we started, we are done.
        return;
      }
      const vNextParentSibling = vnode_getNextSibling(vParent);
      if (vNextParentSibling) {
        vCursor = vNextParentSibling;
        break;
      }
      vParent = vnode_getParent(vParent);
    }
    if (vParent == null) {
      // We are done.
      return;
    }
  } while (true as boolean);
}

function cleanupStaleUnclaimedProjection(journal: VNodeJournal, projection: VNode) {
  // we are removing a node where the projection would go after slot render.
  // This is not needed, so we need to cleanup still unclaimed projection
  const projectionParent = vnode_getParent(projection);
  if (projectionParent) {
    const projectionParentType = projectionParent[VNodeProps.flags];
    if (
      projectionParentType & VNodeFlags.Element &&
      vnode_getElementName(projectionParent as ElementVNode) === 'q:template'
    ) {
      // if parent is the q:template element then projection is still unclaimed - remove it
      vnode_remove(journal, projectionParent, projection, true);
    }
  }
}

/**
 * This marks the property as immutable. It is needed for the QRLs so that QwikLoader can get a hold
 * of them. This character must be `:` so that the `vnode_getAttr` can ignore them.
 */
const HANDLER_PREFIX = ':';
let count = 0;