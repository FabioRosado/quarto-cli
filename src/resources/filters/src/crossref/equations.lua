-- process all equations
function equations()

  return {
    Inlines = function(inlines)

      -- do nothing if there is no math herein
      if inlines:find_if(isDisplayMath) == nil then
        return inlines
      end

      local mathInlines = nil
      local targetInlines = pandoc.List:new()

      for i, el in ipairs(inlines) do

        -- see if we need special handling for pending math, if
        -- we do then track whether we should still process the
        -- inline at the end of the loop
        local processInline = true
        if mathInlines then
          if el.t == "Space" then
            mathInlines:insert(el.t)
            processInline = false
          elseif el.t == "Str" and refLabel("eq", el) then

            -- add to the index
            local label = refLabel("eq", el)
            local order = indexNextOrder("eq")
            indexAddEntry(label, nil, order)

            -- get the equation
            local eq = mathInlines[1]

            -- write equation
            if isLatexOutput() then
              targetInlines:insert(pandoc.RawInline("latex", "\\begin{equation}"))
              targetInlines:insert(pandoc.Span(pandoc.RawInline("latex", eq.text), pandoc.Attr(label)))
              targetInlines:insert(pandoc.RawInline("latex", "\\label{" .. label .. "}\\end{equation}"))
            else
              eq.text = eq.text .. " \\qquad(" .. tostring(order) .. ")"
              local span = pandoc.Span(eq, pandoc.Attr(label))
              targetInlines:insert(span)
            end

            -- reset state
            mathInlines = nil
            processInline = false
          else
            targetInlines:extend(mathInlines)
            mathInlines = nil
          end
        end

        -- process the inline unless it was already taken care of above
        if processInline then
          if isDisplayMath(el) then
              mathInlines = pandoc.List:new()
              mathInlines:insert(el)
            else
              targetInlines:insert(el)
          end
        end

      end

      -- flush any pending math inlines
      if mathInlines then
        targetInlines:extend(mathInlines)
      end

      -- return the processed list
      return targetInlines

    end
  }

end

function isDisplayMath(el)
  return el.t == "Math" and el.mathtype == "DisplayMath"
end
