import { getYouTubeTitleNodeSelector } from "../../maze-utils/src/elements";
import { getOriginalTitleElement } from "../titles/titleRenderer";
import { BrandingLocation, replaceCurrentVideoBranding } from "../videoBranding/videoBranding";
import { waitForElement } from "../../maze-utils/src/dom";
import { onMobile } from "../../maze-utils/src/pageInfo";
import { logError } from "./logger";
import { waitFor } from "../../maze-utils/src";
import { getYouTubeTitleNode } from "../../maze-utils/src/elements";
import { addCleanupListener } from "../../maze-utils/src/cleanup";

export enum MobileFix {
    Replace,
    CopyStyles
}

export interface MobileFixAction {
    type: MobileFix;
    element: HTMLElement;
}

const nodesToListenFor = new Map<HTMLElement, MobileFixAction[]>();

let titleButtonContainer: HTMLElement | null = null;
let lastReferenceNode: HTMLElement | null = null;

export async function getOrCreateTitleButtonContainer(forceTitleNode?: HTMLElement): Promise<HTMLElement | null> {
    const titleNode = forceTitleNode ?? await waitForElement(getYouTubeTitleNodeSelector(), true) as HTMLElement;

    // First case is for "proper description" userscript
    const referenceNode = titleNode?.classList?.contains?.("ytd-video-primary-info-renderer")
            || titleNode?.classList?.contains?.("slim-video-information-title") ? 
        titleNode : titleNode?.parentElement;

    if (referenceNode) {
        if (!titleButtonContainer || titleButtonContainer.parentElement !== referenceNode) {
            titleButtonContainer ??= referenceNode.querySelector(".cbTitleButtonContainer") as HTMLElement;
            if (!titleButtonContainer) {
                titleButtonContainer = document.createElement("div");
                titleButtonContainer.classList.add("cbTitleButtonContainer");
            }

            if (titleButtonContainer.parentElement !== referenceNode) {
                referenceNode.appendChild(titleButtonContainer);

                // Buttons on right
                referenceNode.style.display = "flex";
                referenceNode.style.justifyContent = "space-between";

                if (onMobile()) {
                    if (lastReferenceNode !== referenceNode) {
                        if (lastReferenceNode) {
                            removeNodeToListenFor(lastReferenceNode);
                        }

                        lastReferenceNode = referenceNode;

                        nodesToListenFor
                        addNodeToListenFor(titleButtonContainer, MobileFix.Replace);

                        referenceNode.parentElement!.addEventListener("click", () => {
                            if (!chrome.runtime?.id) return; // Extension context invalidated

                            // Now the description with a second title element will be shown
                            const selector = ".primary-info .title";

                            // If it already exists, this menu is about to be closed
                            if (!document.querySelector(selector)) {
                                waitForElement(selector).then((element) => {
                                    if (element) {
                                        replaceCurrentVideoBranding().catch(logError);
                                    }
                                }).catch(logError);
                            }
                        });
                    }
                }
            }
        }

        return titleButtonContainer;
    }

    return null;
}

export function addNodeToListenFor(node: HTMLElement, type: MobileFix) {
    const existingListenFor = nodesToListenFor.get(node.parentElement!);
    if (existingListenFor) {
        if (!existingListenFor.find((fix) => fix.element === node)) {
            existingListenFor.push({ type, element: node });
        }
    } else {
        nodesToListenFor.set(node.parentElement!, [{ type, element: node }]);

        setupRemovalListener(node.parentElement!);
    }

    cleanNodeToListenFor();
}

const mobileMutationObservers = new Map<HTMLElement, MutationObserver>();
export function removeNodeToListenFor(parentNode: HTMLElement) {
    const mutationObserver = mobileMutationObservers.get(parentNode);
    if (mutationObserver) {
        mutationObserver.disconnect();
        mobileMutationObservers.delete(parentNode);
    }

    nodesToListenFor.delete(parentNode);
}

let lastGarbageCollection = 0;
function cleanNodeToListenFor() {
    if (performance.now() - lastGarbageCollection > 5000) {
        for (const node of [...nodesToListenFor.keys()]) {
            if (!node.isConnected) {
                removeNodeToListenFor(node);
            }
        }

        lastGarbageCollection = performance.now();
    }
}

function setupRemovalListener(referenceNode: HTMLElement) {
    let mutationObserver = mobileMutationObservers.get(referenceNode);
    mutationObserver?.disconnect?.();

    // Add back element if YouTube deleted it
    mutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === "childList") {
                for (const node of mutation.removedNodes) {
                    const fixInfo = nodesToListenFor.get(referenceNode)!.find((fix) => fix.element === node);
                    if (fixInfo && fixInfo.element.parentElement !== referenceNode) {
                        switch (fixInfo.type) {
                            case MobileFix.Replace:
                                referenceNode.appendChild(node);
                                break;
                            case MobileFix.CopyStyles: {
                                const selector = [...(node as HTMLElement).classList].map((c) => `.${c}`).join(", ");
                                waitFor(() => referenceNode.querySelector(selector)).then((element) => {
                                    if (element) {
                                        (element as HTMLElement).style.cssText = (node as HTMLElement).style.cssText;
                                        fixInfo.element = element as HTMLElement;
                                    }
                                }).catch(logError);
                                break;
                            }
                        }
                    }
                }
            }
        }
    });

    mutationObserver.observe(referenceNode, {
        childList: true
    });

    mobileMutationObservers.set(referenceNode, mutationObserver);
}

let badgeListener: MutationObserver | null = null;
export async function listenForBadges() {
    const titleNode = await waitForElement(getYouTubeTitleNodeSelector(), true) as HTMLElement;
    const referenceNode = titleNode?.parentElement;

    if (referenceNode) {
        badgeListener?.disconnect();
        badgeListener = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === "childList") {
                    for (const node of mutation.addedNodes) {
                        if (node instanceof HTMLElement
                                && node.classList.contains("ytd-badge-supported-renderer")) {
                            moveBadge(node);
                        }
                    }
                }
            }
        });

        badgeListener.observe(referenceNode, { childList: true });

        const badges = referenceNode.querySelectorAll("#title > ytd-badge-supported-renderer");
        for (const badge of badges) {
            moveBadge(badge as HTMLElement);
        }
    }
}

function moveBadge(badge: HTMLElement) {
    if (badge.parentElement?.parentElement) {
        // Move badges (unlisted, funding) up one element to fix layout issues
        badge.parentElement!.parentElement!.insertBefore(badge, badge.parentElement!.nextSibling);
    }
}

let titleChangeObserver: MutationObserver | null = null;
const titleChangeListeners: (() => void)[] = [];
export async function listenForTitleChange() {
    const titleNode = await waitForElement(getYouTubeTitleNodeSelector(), true) as HTMLElement;
    titleChangeObserver = setupTextChangeListener(titleChangeObserver, titleNode, true);
}

let miniplayerTitleChangeObserver: MutationObserver | null = null;
export async function listenForMiniPlayerTitleChange() {
    if (onMobile()) return;

    const titleNode = await waitForElement(".miniplayer yt-formatted-string") as HTMLElement;
    miniplayerTitleChangeObserver = setupTextChangeListener(miniplayerTitleChangeObserver, titleNode, false);
}

function setupTextChangeListener(mutationObserver: MutationObserver | null, element: HTMLElement,
        lookForOriginalTitleElement: boolean) {
    if (element) {
        const getTitleElement = () => lookForOriginalTitleElement 
            ? getOriginalTitleElement(element, BrandingLocation.Watch)
            : element;
        let originalTitleElement = getTitleElement();
        if (originalTitleElement) {
            mutationObserver?.disconnect();

            let oldText = originalTitleElement.textContent;
            mutationObserver = new MutationObserver(() => {
                if (!chrome.runtime?.id) return;

                if (onMobile() && lookForOriginalTitleElement) {
                    const newElement = getYouTubeTitleNode();
                    if (newElement && element !== newElement) {
                        setupTextChangeListener(mutationObserver, newElement, lookForOriginalTitleElement);
                        return;
                    }

                    originalTitleElement = getTitleElement();
                }
                
                if (oldText !== originalTitleElement.textContent) {
                    oldText = originalTitleElement.textContent;
                    for (const listener of titleChangeListeners) {
                        listener();
                    }
                }
            });

            const referenceElement = !onMobile() ? originalTitleElement : originalTitleElement.parentElement!.parentElement!;

            mutationObserver.observe(referenceElement, {
                characterData: true,
                subtree: true,
                childList: true
            });
        }
    }

    return mutationObserver;
}
    
export function addTitleChangeListener(listener: () => void) {
    titleChangeListeners.push(listener);
}

export function removeTitleChangeListener(listener: () => void) {
    const index = titleChangeListeners.indexOf(listener);
    if (index !== -1) {
        titleChangeListeners.splice(index, 1);
    }
}

export function setupTitlebarCleanup() {
    addCleanupListener(() => {
        for (const mobileMutationObserver of mobileMutationObservers) {
            mobileMutationObserver[1].disconnect();
        }

        mobileMutationObservers.clear();

        badgeListener?.disconnect?.();
        titleChangeObserver?.disconnect?.();
        miniplayerTitleChangeObserver?.disconnect?.();
    });
}