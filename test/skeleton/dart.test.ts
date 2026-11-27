import { describe, expect, it } from "vitest";
import { sk } from "./helpers.js";

const SRC = `import 'package:flutter/material.dart';
import '../services/auth.dart' as auth;
export 'src/widgets.dart';
part 'session.g.dart';

/// Max retries.
const kMaxRetries = 3;
final String appName = 'demo';
var _counter = 0;

/// Adds numbers.
int add(int a, [int b = 0]) => a + b;

Future<void> _warmUp() async {
  await Future.delayed(Duration.zero);
}

abstract class Shape<T> extends Base with Mx implements Comparable<Shape> {
  final double width;
  int _cached = 0;
  static const unit = 1.0;

  Shape(this.width);
  Shape.square(double side) : width = side;
  factory Shape.parse(String s) => Square(double.parse(s));

  double area();

  /// Perimeter.
  double perimeter() {
    return 0;
  }

  int get sides => 4;
  void _recompute() {}
}

mixin Mx on Base {
  void mix() {}
}

extension StringX on String {
  bool get isBlank => trim().isEmpty;
}

enum Color { red, green }

typedef Callback = void Function(int value);

class _Private {
  void hidden() {}
}
`;

describe("dart skeleton", () => {
  it("extracts top-level functions, variables, classes, mixins, extensions, enums and typedefs", async () => {
    expect((await sk("dart", SRC)).symbols).toEqual([
      "+const kMaxRetries 6-7 | ",
      "+const appName 8-8 | String",
      "-variable _counter 9-9 | ",
      "+function add 11-12 | (int a, [int b = 0])",
      "-function _warmUp 14-16 | ()",
      "+class Shape 18-36 | <T> extends Base with Mx implements Comparable<Shape>",
      "+property Shape.width 19-19 | double",
      "-property Shape._cached 20-20 | int",
      "+property Shape.unit 21-21 | ",
      "+method Shape.new 23-23 | (this.width)",
      "+method Shape.square 24-24 | (double side)",
      "+method Shape.parse 25-25 | (String s)",
      "+method Shape.area 27-27 | ()",
      "+method Shape.perimeter 29-32 | ()",
      "+method Shape.sides 34-34 | ",
      "-method Shape._recompute 35-35 | ()",
      "+mixin Mx 38-40 | on Base",
      "+method Mx.mix 39-39 | ()",
      "+extension StringX 42-44 | on String",
      "+method StringX.isBlank 43-43 | ",
      "+enum Color 46-46 | ",
      "+type Callback 48-48 | = void Function(int value)",
      "-class _Private 50-52 | ",
      "-method _Private.hidden 51-51 | ()",
    ]);
  });

  it("collects import, export and part URIs raw", async () => {
    expect((await sk("dart", SRC)).imports).toEqual([
      "package:flutter/material.dart",
      "../services/auth.dart",
      "src/widgets.dart",
      "session.g.dart",
    ]);
  });
});
