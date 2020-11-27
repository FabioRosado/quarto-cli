-- initialize options from 'crossref' metadata value
function initOptions()
  return {
    Pandoc = function(doc)
      if type(doc.meta["crossref"]) == "table" then
        crossref.options = doc.meta["crossref"]:clone()
      end
      return doc
    end
  }
end

-- get option value
function option(name, default)
  local value = crossref.options[name]
  if value == nil then
    value = default
  end
  return value
end



