"use strict";
const observedCourseApiUrls = new Set();
let networkCaptureSetup = false;
let latestCourseBrief = null;
let latestPageKey = "";
let lastRecoveryRequestUrl = "";
let lastRecoveryAttemptAt = 0;
const RECOVERY_COOLDOWN_MS = 60000;
let originalFetchRef = null;
function normalizeVideoUrlForMatch(url) {
    try {
        const u = new URL(url);
        if (u.pathname.toLowerCase().endsWith(".mp4")) {
            u.search = "";
            u.hash = "";
        }
        return u.toString();
    }
    catch {
        return url;
    }
}
function isCourseVodApiUrl(url) {
    try {
        const u = new URL(url, window.location.href);
        return u.pathname.includes("/jy-application-vod-he/v1/course_vod_urls");
    }
    catch {
        return false;
    }
}
function getPageKey(pageUrl) {
    try {
        const u = new URL(pageUrl);
        if (u.hash.startsWith("#/video-detail")) {
            const q = u.hash.includes("?") ? u.hash.split("?")[1] : "";
            const params = new URLSearchParams(q);
            const id = params.get("id") || "";
            return `detail:${id}`;
        }
        if (u.hash.startsWith("#/video")) {
            return "list";
        }
    }
    catch {
        // fall through
    }
    return "";
}
function extractCourseBrief(payload, apiUrl) {
    if (!payload || typeof payload !== "object")
        return null;
    const root = payload;
    const data = root.data;
    if (!data || typeof data !== "object")
        return null;
    const obj = data;
    const list = Array.isArray(obj.courseVodViewList)
        ? obj.courseVodViewList
        : [];
    const courseVods = [];
    for (const item of list) {
        if (!item || typeof item !== "object")
            continue;
        const vod = item;
        const url = typeof vod.url === "string" ? vod.url.trim() : "";
        if (!url)
            continue;
        const viewNum = typeof vod.viewNum === "number" ? vod.viewNum : null;
        const label = viewNum === 1
            ? "讲台视频"
            : viewNum === 5
                ? "PPT演示视频"
                : "其他视频";
        courseVods.push({
            url,
            viewNum,
            label,
            vodId: typeof vod.vodId === "number" ? vod.vodId : null,
        });
    }
    return {
        courId: typeof obj.id === "number" ? obj.id : null,
        courseCode: typeof obj.courCode === "string"
            ? obj.courCode
            : typeof obj.teachClassCode === "string"
                ? obj.teachClassCode
                : typeof obj.subjCode === "string"
                    ? obj.subjCode
                    : null,
        courseName: typeof obj.courName === "string" ? obj.courName : null,
        teacherName: typeof obj.tecName === "string" ? obj.tecName : null,
        classRoomName: typeof obj.classRoomName === "string" ? obj.classRoomName : null,
        lessonName: typeof obj.letiName === "string" ? obj.letiName : null,
        yearTerm: typeof obj.yearTerm === "string" ? obj.yearTerm : null,
        beginTime: typeof obj.courBeginTime === "number" ? obj.courBeginTime : null,
        endTime: typeof obj.courEndTime === "number" ? obj.courEndTime : null,
        openType: typeof obj.openType === "string" ? obj.openType : null,
        vodCount: courseVods.length,
        apiUrl,
        courseVods,
    };
}
async function captureCourseInfoFromFetchResponse(requestUrl, response) {
    const responseUrl = response.url || requestUrl || "";
    if (!isCourseVodApiUrl(responseUrl))
        return;
    observedCourseApiUrls.add(responseUrl);
    try {
        const payload = await response.clone().json();
        const brief = extractCourseBrief(payload, responseUrl);
        if (brief)
            latestCourseBrief = brief;
    }
    catch {
        // Ignore non-JSON or parse failures from duplicated/partial responses.
    }
}
function captureCourseInfoFromXhrResponse(xhr, url) {
    if (!isCourseVodApiUrl(url))
        return;
    observedCourseApiUrls.add(url);
    try {
        const payload = JSON.parse(xhr.responseText || "");
        const brief = extractCourseBrief(payload, url);
        if (brief)
            latestCourseBrief = brief;
    }
    catch {
        // Ignore parse failures.
    }
}
async function fetchAndCaptureCourseApi(url) {
    if (!isCourseVodApiUrl(url))
        return;
    observedCourseApiUrls.add(url);
    try {
        const fetchImpl = originalFetchRef ?? window.fetch.bind(window);
        const response = await fetchImpl(url, { credentials: "include" });
        if (!response.ok)
            return;
        const payload = await response.json();
        const brief = extractCourseBrief(payload, url);
        if (brief)
            latestCourseBrief = brief;
    }
    catch {
        // Ignore fallback fetch failures.
    }
}
function tryRecoverCourseInfoFromPerformanceEntries() {
    if (latestCourseBrief)
        return;
    const now = Date.now();
    const resources = performance.getEntriesByType("resource");
    for (let i = resources.length - 1; i >= 0; i -= 1) {
        const url = resources[i]?.name || "";
        if (isCourseVodApiUrl(url)) {
            if (url === lastRecoveryRequestUrl &&
                now - lastRecoveryAttemptAt < RECOVERY_COOLDOWN_MS) {
                continue;
            }
            lastRecoveryRequestUrl = url;
            lastRecoveryAttemptAt = now;
            void fetchAndCaptureCourseApi(url);
            return;
        }
    }
}
function forceRecoverFromLastObservedApiUrl() {
    const urls = Array.from(observedCourseApiUrls);
    if (!urls.length)
        return;
    const latestUrl = urls[urls.length - 1];
    if (!latestUrl)
        return;
    // Bypass cooldown when currently playing video no longer matches cached metadata.
    lastRecoveryRequestUrl = "";
    lastRecoveryAttemptAt = 0;
    void fetchAndCaptureCourseApi(latestUrl);
}
function isAirClassroomPage(pageUrl) {
    if (!pageUrl)
        return false;
    try {
        const u = new URL(pageUrl);
        const hostMatched = u.hostname === "courses.sufe.edu.cn" ||
            u.hostname.endsWith(".sufe.edu.cn");
        const hash = u.hash || "";
        const isVideoList = hash === "#/video" || hash.startsWith("#/video?");
        const isVideoDetail = hash.startsWith("#/video-detail");
        const hasId = /[?&]id=\d+/.test(hash);
        return hostMatched && (isVideoList || (isVideoDetail && hasId));
    }
    catch {
        return false;
    }
}
function setupNetworkCapture() {
    if (networkCaptureSetup)
        return;
    networkCaptureSetup = true;
    try {
        const originalFetch = window.fetch.bind(window);
        originalFetchRef = originalFetch;
        window.fetch = async (...args) => {
            const [input] = args;
            let requestUrl = null;
            if (typeof input === "string") {
                requestUrl = input;
            }
            else if (input instanceof Request) {
                requestUrl = input.url;
            }
            const response = await originalFetch(...args);
            void captureCourseInfoFromFetchResponse(requestUrl, response);
            return response;
        };
    }
    catch (error) {
        console.warn("Fetch hook unavailable; fallback to other probes.", error);
    }
    try {
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, async, username, password) {
            const rawUrl = String(url);
            this.addEventListener("load", () => {
                captureCourseInfoFromXhrResponse(this, rawUrl);
            });
            return originalOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
        };
    }
    catch (error) {
        console.warn("XHR hook unavailable; fallback to other probes.", error);
    }
}
function getMainVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    if (!videos.length)
        return null;
    return videos.sort((a, b) => {
        const areaA = a.clientWidth * a.clientHeight;
        const areaB = b.clientWidth * b.clientHeight;
        return areaB - areaA;
    })[0];
}
function getVideoInfo() {
    const inAirClassroom = isAirClassroomPage(window.location.href);
    if (inAirClassroom) {
        setupNetworkCapture();
        const pageKey = getPageKey(window.location.href);
        if (latestPageKey && pageKey && latestPageKey !== pageKey) {
            observedCourseApiUrls.clear();
            latestCourseBrief = null;
            lastRecoveryRequestUrl = "";
            lastRecoveryAttemptAt = 0;
        }
        latestPageKey = pageKey;
        tryRecoverCourseInfoFromPerformanceEntries();
    }
    else {
        observedCourseApiUrls.clear();
        latestCourseBrief = null;
        latestPageKey = "";
        lastRecoveryRequestUrl = "";
        lastRecoveryAttemptAt = 0;
    }
    const video = getMainVideo();
    // In video-detail page, switching lesson may not change URL/hash.
    // If the actively playing video no longer belongs to cached lesson metadata,
    // force a metadata refresh from the last observed course API URL.
    if (inAirClassroom && video && latestCourseBrief) {
        const activeSrc = video.currentSrc || video.src || "";
        if (activeSrc) {
            const activeNorm = normalizeVideoUrlForMatch(activeSrc);
            const matched = latestCourseBrief.courseVods.some((item) => normalizeVideoUrlForMatch(item.url) === activeNorm);
            if (!matched) {
                latestCourseBrief = null;
                forceRecoverFromLastObservedApiUrl();
            }
        }
    }
    const candidateUrls = inAirClassroom && latestCourseBrief
        ? latestCourseBrief.courseVods.map((item) => item.url)
        : [];
    return {
        src: inAirClassroom && video
            ? video.currentSrc || video.src || null
            : null,
        currentTime: inAirClassroom && video && Number.isFinite(video.currentTime)
            ? video.currentTime
            : null,
        duration: inAirClassroom && video && Number.isFinite(video.duration)
            ? video.duration
            : null,
        paused: inAirClassroom && video ? video.paused : true,
        title: document.title,
        pageUrl: window.location.href,
        candidateUrls,
        courseApiUrls: Array.from(observedCourseApiUrls),
        courseBrief: latestCourseBrief,
        probeStatus: "live",
    };
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "GET_VIDEO_INFO") {
        sendResponse(getVideoInfo());
        return true;
    }
    if (message.type === "SEEK_VIDEO") {
        const video = getMainVideo();
        if (!video || typeof message.time !== "number") {
            sendResponse({ ok: false });
            return true;
        }
        video.currentTime = message.time;
        video.play().catch(() => undefined);
        sendResponse({ ok: true });
        return true;
    }
    return false;
});
