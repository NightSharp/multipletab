/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log,
  handleMissingReceiverError
} from './common.js';
import * as Constants from './constants.js';

export async function getActiveWindow() {
  return browser.windows.getLastFocused({ populate: true });
}

export async function getAllTabs(windowId) {
  if (!windowId)
    windowId = (await getActiveWindow()).id;
  return browser.tabs.query({ windowId });
}

export async function getSelection(windowId) {
  if (!windowId)
    windowId = (await getActiveWindow()).id;
  return browser.tabs.query({ windowId, highlighted: true });
}

export async function getSelectionAndOthers(windowId) {
  if (!windowId)
    windowId = (await getActiveWindow()).id;
  const [allTabs, selectedTabs] = await Promise.all([
    getAllTabs(windowId),
    getSelection(windowId)
  ]);
  const selectedTabIds = selectedTabs.map(tab => tab.id);
  return {
    selected:   selectedTabs,
    unselected: allTabs.filter(tab => !selectedTabIds.includes(tab.id))
  };
}


const mToBeSelected   = new Map();
const mToBeUnselected = new Map();
const mTabStates      = new Map();
let mClearSelection = false;
let mDelayedUpdate = null;
function requestUpdateHighlightedState(params = {}) {
  if (params.clear)
    mClearSelection = true;
  if (params.selected) {
    for (const tab of params.selected) {
      mToBeSelected.set(tab.id, tab);
      mToBeUnselected.delete(tab.id);
      mClearSelection = false;
    }
  }
  if (params.unselected) {
    for (const tab of params.unselected) {
      mToBeUnselected.set(tab.id, tab);
      mToBeSelected.delete(tab);
      mClearSelection = false;
    }
  }
  if (mDelayedUpdate)
    clearTimeout(mDelayedUpdate);
  mDelayedUpdate = setTimeout(async () => {
    mDelayedUpdate = null;
    let toBeSelected = Array.from(mToBeSelected.values());
    const toBeUnselected = Array.from(mToBeUnselected.values());
    const clear = mClearSelection;
    log('requestUpdateHighlightedState: update now ', { toBeSelected, toBeUnselected, clear });
    if (!clear && toBeSelected.length === 0 && toBeUnselected.length > 0) {
      const unselectedIds = toBeUnselected.map(tab => tab.id);
      toBeSelected = await getSelection(toBeUnselected[0].windowId);
      toBeSelected = toBeSelected.filter(tab => !unselectedIds.includes(tab.id));
      const activeTabs = toBeSelected.splice(toBeSelected.findIndex(tab => tab.active), 1);
      toBeSelected = activeTabs.concat(toBeSelected);
      log('requestUpdateHighlightedState:unselect ', toBeSelected);
      browser.tabs.highlight({
        windowId: toBeSelected[0].windowId,
        populate: false,
        tabs:     toBeSelected.map(tab => tab.index)
      });
    }
    else if (!clear && toBeSelected.length > 0) {
      // refresh array of tabs, because active tab can be changed while selecting
      const allTabs = await getAllTabs(toBeSelected[0].windowId);
      toBeSelected = allTabs.filter(tab => mToBeSelected.has(tab.id));
      const activeTabs = toBeSelected.splice(toBeSelected.findIndex(tab => tab.active), 1);
      toBeSelected = activeTabs.concat(toBeSelected);
      log('requestUpdateHighlightedState:select ', toBeSelected);
      browser.tabs.highlight({
        windowId: toBeSelected[0].windowId,
        populate: false,
        tabs:     toBeSelected.map(tab => tab.index)
      });
    }
    else {
      log('requestUpdateHighlightedState:clear');
      const windowId = (await getActiveWindow()).id;
      const activeTabs = await browser.tabs.query({ windowId, active: true });
      browser.tabs.highlight({
        windowId,
        populate: false,
        tabs:     activeTabs.map(tab => tab.index)
      });
    }
    mToBeSelected.clear();
    mToBeUnselected.clear();
    mClearSelection = false;
  }, 100);
}

export async function clear(options = {}) {
  let windowId = options.windowId;
  if (!windowId)
    windowId = (await getActiveWindow()).id;
  const selectedTabs = await (options.force ? /* getAllTabs(windowId) */ null : getSelection(windowId));
  const promises = [
    (options.force ? clearTabStateFromTST : notifyTabStateToTST)(options.force ? windowId : selectedTabs.map(tab => tab.id), [Constants.kSELECTED, Constants.kREADY_TO_SELECT], false)
  ];
  if (options.highlighted !== false)
    requestUpdateHighlightedState({ clear: true })
  await Promise.all(promises);
}

export async function select(tabsOrTab) {
  if (!tabsOrTab)
    return;
  if (Array.isArray(tabsOrTab)) {
    if (tabsOrTab.length === 0)
      return;
    const tabIds = tabsOrTab.map(tab => tab.id);
    const selection = await getSelectionAndOthers(tabsOrTab[0].windowId);
    const toBeUnselected = selection.selected.filter(tab => !tabIds.includes(tab.id));
    const toBeSelected = selection.unselected.filter(tab => tabIds.includes(tab.id));
    notifyTabStateToTST(toBeUnselected.map(tab => tab.id), Constants.kSELECTED, false);
    notifyTabStateToTST(toBeSelected.map(tab => tab.id), Constants.kSELECTED, true);
    requestUpdateHighlightedState({ selected: tabsOrTab });
  }
  else {
    notifyTabStateToTST(tabsOrTab.id, Constants.kSELECTED, true);
    requestUpdateHighlightedState({ selected: [tabsOrTab] });
  }
}

export async function unselect(tabsOrTab) {
  if (!tabsOrTab)
    return;
  if (Array.isArray(tabsOrTab)) {
    if (tabsOrTab.length === 0)
      return;
    const selectedTabs = await getSelection(tabsOrTab[0].windowId);
    const tabIds       = tabsOrTab.map(tab => tab.id);
    notifyTabStateToTST(tabIds, Constants.kSELECTED, false);
    requestUpdateHighlightedState({ selected: selectedTabs.filter(tab => !tabIds.includes(tab.id)) });
  }
  else {
    notifyTabStateToTST(tabsOrTab.id, Constants.kSELECTED, false);
    requestUpdateHighlightedState({ unselected: [tabsOrTab] });
  }
}

export async function selectAll(windowId) {
  if (!windowId)
    windowId = (await getActiveWindow()).id;
  const tabs = await getAllTabs(windowId);
  return select(tabs);
}

export async function toggle(tab) {
  if (!tab)
    return;
  if (tab.highlighted)
    return unselect(tab);
  else
    return select(tab);
}

export async function invert(windowId) {
  if (!windowId)
    windowId = (await getActiveWindow()).id;
  const selection = await getSelectionAndOthers(windowId);
  notifyTabStateToTST(selection.selected.map(tab => tab.id), Constants.kSELECTED, false);
  notifyTabStateToTST(selection.unselected.map(tab => tab.id), Constants.kSELECTED, true);
  requestUpdateHighlightedState({ selected: selection.unselected });
}

export async function clearTabStateFromTST(windowId, state, value = false) {
  const tstTabs = await browser.runtime.sendMessage(Constants.kTST_ID, {
    type:   'get-tree',
    window: windowId,
    tabs:   '*',
  }).catch(handleMissingReceiverError);
  if (!tstTabs)
    return; // TST not found/ready.

  const affectedStates = Array.isArray(state) ? state : [state];
  const affectedTabs = tstTabs.filter(tab => {
    for (const state of affectedStates) {
      const states = mTabStates.get(tab.id);
      const hasState = states && states.has(state);
      if (value) {
        if (!hasState) // Add state => Only need to update tab if the tab doesn't have a wanted state.
          return true;
      }
      else if (hasState) { // Remove state => Only need to update tab if it has an affected state.
        return true;
      }
    }
  });

  return notifyTabStateToTST(affectedTabs, state, value);
}

export async function notifyTabStateToTST(tabIds, state, value) {
  if (!Array.isArray(tabIds))
    tabIds = [tabIds];
  if (tabIds.length == 0)
    return;

  for (const id of tabIds) {
    const states = mTabStates.get(id) || new Set();
    if (value)
      states.add(state);
    else
      states.delete(state);

    if (states.size > 0)
      mTabStates.set(id, states);
    else
      mTabStates.delete(id);
  }

  browser.runtime.sendMessage(Constants.kTST_ID, {
    type:  value ? Constants.kTSTAPI_ADD_TAB_STATE : Constants.kTSTAPI_REMOVE_TAB_STATE,
    tabs:  tabIds,
    state: state
  }).catch(handleMissingReceiverError);
}
