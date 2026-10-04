# Weather station: overview

This is a made-up project. It exists to show what a pack looks like.

## What it is

A small outdoor station that measures temperature, humidity and pressure once a minute and sends the readings over Wi-Fi. It runs from one lithium cell charged by a small solar panel.

## Parts

- Microcontroller board with Wi-Fi
- Combined temperature, humidity and pressure sensor on the I2C bus
- Single-cell lithium battery with a protection board
- Solar panel and a charge controller

## State of the build

- Sensor reads correctly on the bench.
- Wi-Fi upload works.
- Deep sleep is not working yet: the board wakes but the sensor returns zeros on the first read.

## Open questions

- Does the sensor need a delay after wake before the first read?
- Is the battery large enough for three days without sun?
