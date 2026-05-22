-- claude-focus.lua
--
-- Watches window focus + title changes across all apps. When the focused
-- window's title matches "claude:<session_id> ...", atomically writes
--   <session_id>\t<unix_ms>\n
-- to ~/.claude/focus/active. Aggregator tails that file to highlight the
-- currently-focused session's div.
--
-- Activate by adding this line to ~/.hammerspoon/init.lua:
--   require('claude-focus')

local M = {}

local ACTIVE_FILE = os.getenv("HOME") .. "/.claude/focus/active"
local PATTERN = "claude:([%w%-]+)"

local function nowMs()
  -- hs.timer.secondsSinceEpoch returns float seconds with sub-ms precision.
  return math.floor(hs.timer.secondsSinceEpoch() * 1000)
end

local function writeActive(sessionId)
  local tmp = ACTIVE_FILE .. ".tmp"
  local f = io.open(tmp, "w")
  if not f then return end
  if sessionId then
    f:write(sessionId .. "\t" .. tostring(nowMs()) .. "\n")
  end
  f:close()
  os.rename(tmp, ACTIVE_FILE)
end

local lastWritten = nil

local function update(win)
  if not win then
    if lastWritten ~= "" then
      writeActive(nil)
      lastWritten = ""
    end
    return
  end
  local title = win:title() or ""
  local id = title:match(PATTERN)
  if id then
    if id ~= lastWritten then
      writeActive(id)
      lastWritten = id
    end
  else
    if lastWritten ~= "" then
      writeActive(nil)
      lastWritten = ""
    end
  end
end

local filter = hs.window.filter.new(nil)
  :setOverrideFilter({ visible = true })

filter:subscribe(hs.window.filter.windowFocused, function(win) update(win) end)
filter:subscribe(hs.window.filter.windowTitleChanged, function(win)
  -- Only react if this window is the focused one (tab switches in terminal
  -- apps fire title-change on the same window).
  if win == hs.window.focusedWindow() then update(win) end
end)
filter:subscribe(hs.window.filter.windowUnfocused, function()
  -- Defer; another window's focused event will usually follow.
  hs.timer.doAfter(0.05, function() update(hs.window.focusedWindow()) end)
end)

-- Prime on load.
update(hs.window.focusedWindow())

M.filter = filter
return M
