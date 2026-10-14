import { params } from '../config.js'

/**
 * The small panel shown without #debug: number of leaves, falling,
 * regrowth, reset and shake. Everything else lives in DebugUI (#debug).
 */
export class BasicPanel
{
    constructor({ rig, simulation, onChange, onReset })
    {
        const element = document.getElementById('basic-panel')
        element.hidden = false

        // Number of leaves
        const countLabel = document.createElement('label')
        countLabel.className = 'row'
        const countName = document.createElement('span')
        countName.textContent = 'hojas'
        const countValue = document.createElement('output')
        const countInput = document.createElement('input')
        countInput.type = 'range'
        countInput.min = 0
        countInput.max = simulation.capacity
        countInput.step = 1
        countInput.value = params.leafCount
        countValue.textContent = params.leafCount
        countInput.addEventListener('input', () =>
        {
            params.leafCount = Number(countInput.value)
            countValue.textContent = countInput.value
            onChange()
        })
        countLabel.append(countName, countInput, countValue)

        // Toggles
        const toggle = (key, text) =>
        {
            const label = document.createElement('label')
            label.className = 'row'
            const name = document.createElement('span')
            name.textContent = text
            const input = document.createElement('input')
            input.type = 'checkbox'
            input.checked = params[key]
            input.addEventListener('change', () =>
            {
                params[key] = input.checked
                onChange()
            })
            label.append(name, input)
            return label
        }

        // Actions
        const button = (text, action) =>
        {
            const element = document.createElement('button')
            element.type = 'button'
            element.textContent = text
            element.addEventListener('click', action)
            return element
        }
        const actions = document.createElement('div')
        actions.className = 'actions'
        actions.append(
            button('reiniciar', onReset),
            button('sacudir todo', () => rig.shakeAll())
        )

        element.append(countLabel, toggle('leafFall', 'caída'), toggle('regeneration', 'regeneración'), actions)
    }

    update()
    {
    }
}
