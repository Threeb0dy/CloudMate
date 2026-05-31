"use strict";

chrome.runtime.onInstalled.addListener(() => {
    console.log("coursedeck extension installed");
});

async function openSidebar(tab) {
    try {
        await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (error) {
        console.error("Failed to open sidebar", error);
    }
}

chrome.action.onClicked.addListener(openSidebar);

chrome.commands.onCommand.addListener((command) => {
    if (command === "open_sidebar") {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) openSidebar(tabs[0]);
        });
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "PING") {
        sendResponse({ ok: true, tabId: sender.tab?.id ?? null });
        return true;
    }
    return false;
});
