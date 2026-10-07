# Дизайн-система ACP UI

Общие визуальные правила и компоненты находятся в репозитории и используются
без зависимости от scoped-стилей родительской страницы.

- `src/styles/tokens.css` — единый источник цветов, шрифтов, радиусов и состояний
  светлой/тёмной темы. Подключается в App.vue; существующая палитра сохранена.
- `src/components/ui/UiButton.vue` — кнопки действий, вкладки и кнопки с иконкой.
- `src/components/ui/UiExpandableRows.vue` — общий показ длинных списков:
  первые 20 строк и кнопка раскрытия остальных. Принимает `rows` и `controlsId`,
  передаёт видимые строки в слот `rows`; у таблицы/списка должен быть соответствующий
  `id`. Скрытие строк не меняет исходные данные, итоги или экспорт.
- `src/styles/controls.css` — классы `ui-input` для input/select/textarea,
  `ui-note` для пояснений, `ui-label` для подписей и `ui-surface` для отдельных
  смысловых блоков. Вариант `ui-surface-accent` выделяет результат для согласования. Подключается в App.vue.

## Кнопки

```vue
<script setup lang="ts">
import UiButton from '../../components/ui/UiButton.vue';
</script>

<template>
  <UiButton @click="close">Close</UiButton>
  <UiButton variant="primary" :disabled="busy" :aria-busy="busy" @click="save">Save</UiButton>
  <UiButton variant="danger" @click="remove">Delete</UiButton>
  <UiButton variant="ghost" size="xs" role="tab" :aria-selected="selected">Plan</UiButton>
  <UiButton icon aria-label="Reload state" @click="refresh">↻</UiButton>
</template>
```

| Свойство | Значения | Назначение |
|---|---|---|
| variant | secondary (по умолчанию), primary, danger, ghost | Обычное действие, основное, опасное, второстепенное/вкладка |
| size | sm (по умолчанию), xs | Высота 28 или 24 px; компактные кнопки для вкладок |
| icon | boolean | Квадратная кнопка; обязательна доступная подпись aria-label |
| type | button (по умолчанию), submit, reset | Нативное поведение в форме |

Все нативные атрибуты и события передаются на настоящий button: disabled,
aria-busy, title, data-testid, click и т.д. Текст передаётся через default slot.
Компонент определяет hover, видимый клавиатурный фокус, disabled и выбранную
вкладку по aria-selected/aria-pressed. Для узких экранов и touch-устройств
минимальная высота и ширина кнопки с иконкой — 44 px.

## Правила использования

1. Для новых и изменяемых кнопок действий используйте UiButton. Не копируйте
   `.btn`, не рассчитывайте на стили родителя и не добавляйте браузерные кнопки
   без явного визуального оформления.
2. Для полей используйте ui-input; для нового сложного контрола сначала
   проверьте существующие примитивы, затем добавьте общий компонент в ui/.
3. Цвета, радиусы и шрифты берите из токенов. Страница задаёт размещение,
   ширину и промежутки; вид кнопки задаёт UiButton. Не переопределяйте её
   фон, border, шрифт, focus или disabled в CSS страницы.
4. Старые специализированные элементы (например, сегменты приоритета и
   кнопки навигации) мигрируются при изменении их поведения/вида; текущая
   миграция охватывает execution, preparation и обычные действия CardDrawer.
5. Перед выпуском проверяйте реальные computed styles, hover, focus,
   disabled, светлую/тёмную тему и узкий экран по TESTING.md. Один только
   SSR не проверяет CSS.
