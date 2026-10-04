# Weather station: numbers

Made-up values for the example. In a real pack, this file holds the figures you want quoted exactly.

## Pins

| Signal | Pin |
| --- | --- |
| I2C data | 8 |
| I2C clock | 9 |
| Battery voltage sense | 4 |

## Limits

| Quantity | Value |
| --- | --- |
| Logic voltage | 3.3 V |
| Battery full | 4.2 V |
| Battery cut-off | 3.0 V |
| Reading interval | 60 s |

## Rules

- Never connect the panel directly to the battery. It goes through the charge controller.
- Do not power the sensor from 5 V.
