-- Loaded into mpv by ytmusic-daemon. Before a YouTube Music URL is opened,
-- swap in the direct audio URL the daemon resolved ahead of time (stored in
-- user-data/ytmusic/<videoId>). Without one, mpv's ytdl_hook resolves it as
-- usual, which takes a couple of seconds.

local PREFIX = "^https://music%.youtube%.com/watch%?v=([%w_-]+)$"

-- Lower priority runs first: ytdl_hook registers on_load with priority 10.
mp.add_hook("on_load", 5, function()
    local url = mp.get_property("stream-open-filename", "")
    local id = url:match(PREFIX)
    if not id then
        return
    end
    local entry = mp.get_property_native("user-data/ytmusic/" .. id)
    if type(entry) ~= "table" or not entry.url then
        return
    end
    if entry.expires and entry.expires < os.time() then
        return
    end
    mp.set_property("stream-open-filename", entry.url)
    if entry.headers then
        mp.set_property_native("file-local-options/http-header-fields", entry.headers)
    end
    if entry.title and entry.title ~= "" then
        mp.set_property("file-local-options/force-media-title", entry.title)
    end
    mp.msg.verbose("ytmusic: using preloaded stream for " .. id)
end)
