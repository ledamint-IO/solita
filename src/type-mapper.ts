import {
  IdlEnumVariant,
  IdlField,
  IdlInstructionArg,
  IdlType,
  IdlTypeArray,
  IdlTypeDefined,
  IdlTypeEnum,
  IdlTypeOption,
  IdlTypeVec,
  isIdlTypeArray,
  isIdlTypeDefined,
  isIdlTypeEnum,
  isIdlTypeOption,
  isIdlTypeVec,
  PrimaryTypeMap,
  PrimitiveTypeKey,
  TypeMappedSerdeField,
} from './types'
import { getOrCreate, logDebug, withoutTsExtension } from './utils'
import { strict as assert } from 'assert'
import {
  BeetTypeMapKey,
  BEET_PACKAGE,
  SupportedTypeDefinition,
  supportedTypeMap as beetSupportedTypeMap,
} from '@metaplex-foundation/beet'
import {
  BeetSolanaTypeMapKey,
  supportedTypeMap as beetSolanaSupportedTypeMap,
} from '@metaplex-foundation/beet-solana'
import {
  assertKnownSerdePackage,
  SerdePackage,
  serdePackageExportName,
} from './serdes'
import { beetVarNameFromTypeName } from './render-type'
import path from 'path'
import { PathLike } from 'fs'

export function resolveSerdeAlias(ty: string) {
  switch (ty) {
    case 'option':
      return 'coption'
    default:
      return ty
  }
}

export type ForceFixable = (ty: IdlType) => boolean
export const FORCE_FIXABLE_NEVER: ForceFixable = () => false

const NO_NAME_PROVIDED = '<no name provided>'
export class TypeMapper {
  readonly serdePackagesUsed: Set<SerdePackage> = new Set()
  readonly localImportsByPath: Map<string, Set<string>> = new Map()
  readonly scalarEnumsUsed: Map<string, string[]> = new Map()
  usedFixableSerde: boolean = false
  constructor(
    /** Account types mapped { typeName: fullPath } */
    private readonly accountTypesPaths: Map<string, string> = new Map(),
    /** Custom types mapped { typeName: fullPath } */
    private readonly customTypesPaths: Map<string, string> = new Map(),
    /** Aliases mapped { alias: actualType } */
    private readonly typeAliases: Map<string, PrimitiveTypeKey> = new Map(),
    private readonly forceFixable: ForceFixable = FORCE_FIXABLE_NEVER,
    private readonly primaryTypeMap: PrimaryTypeMap = TypeMapper.defaultPrimaryTypeMap
  ) {}

  clearUsages() {
    this.serdePackagesUsed.clear()
    this.localImportsByPath.clear()
    this.usedFixableSerde = false
    this.scalarEnumsUsed.clear()
  }

  clone() {
    return new TypeMapper(
      this.accountTypesPaths,
      this.customTypesPaths,
      this.typeAliases,
      this.forceFixable,
      this.primaryTypeMap
    )
  }

  private updateUsedFixableSerde(ty: SupportedTypeDefinition) {
    this.usedFixableSerde = this.usedFixableSerde || ty.isFixable
  }

  private updateScalarEnumsUsed(name: string, ty: IdlTypeEnum) {
    const variants = ty.variants.map((x: IdlEnumVariant) => x.name)
    const currentUsed = this.scalarEnumsUsed.get(name)
    if (currentUsed != null) {
      assert.deepStrictEqual(
        variants,
        currentUsed,
        `Found two enum variant specs for ${name}, ${variants} and ${currentUsed}`
      )
    } else {
      this.scalarEnumsUsed.set(name, variants)
    }
  }

  // -----------------
  // Map TypeScript Type
  // -----------------
  private mapPrimitiveType(ty: PrimitiveTypeKey, name: string) {
    this.assertBeetSupported(ty, 'map primitive type')
    const mapped = this.primaryTypeMap[ty]
    let typescriptType = mapped.ts

    if (typescriptType == null) {
      logDebug(`No mapped type found for ${name}: ${ty}, using any`)
      typescriptType = 'any'
    }
    if (mapped.pack != null) {
      assertKnownSerdePackage(mapped.pack)
      const exp = serdePackageExportName(mapped.pack)
      typescriptType = `${exp}.${typescriptType}`
      this.serdePackagesUsed.add(mapped.pack)
    }
    return typescriptType
  }

  private mapOptionType(ty: IdlTypeOption, name: string) {
    const inner = this.map(ty.option, name)
    const optionPackage = BEET_PACKAGE
    this.serdePackagesUsed.add(optionPackage)
    const exp = serdePackageExportName(optionPackage)
    return `${exp}.COption<${inner}>`
  }

  private mapVecType(ty: IdlTypeVec, name: string) {
    const inner = this.map(ty.vec, name)
    return `${inner}[]`
  }

  private mapArrayType(ty: IdlTypeArray, name: string) {
    const inner = this.map(ty.array[0], name)
    const size = ty.array[1]
    return `${inner}[] /* size: ${size} */`
  }

  private mapDefinedType(ty: IdlTypeDefined) {
    const fullFileDir = this.definedTypesImport(ty)
    const imports = getOrCreate(this.localImportsByPath, fullFileDir, new Set())
    imports.add(ty.defined)
    return ty.defined
  }

  private mapEnumType(ty: IdlTypeEnum, name: string) {
    assert.notEqual(
      name,
      NO_NAME_PROVIDED,
      'Need to provide name for enum types'
    )
    this.updateScalarEnumsUsed(name, ty)
    return name
  }

  map(ty: IdlType, name: string = NO_NAME_PROVIDED): string {
    if (typeof ty === 'string') {
      return this.mapPrimitiveType(ty, name)
    }
    if (isIdlTypeOption(ty)) {
      return this.mapOptionType(ty, name)
    }
    if (isIdlTypeVec(ty)) {
      return this.mapVecType(ty, name)
    }
    if (isIdlTypeArray(ty)) {
      return this.mapArrayType(ty, name)
    }
    if (isIdlTypeDefined(ty)) {
      const alias = this.typeAliases.get(ty.defined)
      return alias == null
        ? this.mapDefinedType(ty)
        : this.mapPrimitiveType(alias, name)
    }
    if (isIdlTypeEnum(ty)) {
      return this.mapEnumType(ty, name)
    }

    throw new Error(`Type ${ty} required for ${name} is not yet supported`)
  }

  // -----------------
  // Map Serde
  // -----------------
  private mapPrimitiveSerde(ty: PrimitiveTypeKey, name: string) {
    this.assertBeetSupported(ty, `account field ${name}`)

    if (ty === 'string') return this.mapStringSerde(ty)

    const mapped = this.primaryTypeMap[ty]

    assertKnownSerdePackage(mapped.sourcePack)
    const packExportName = serdePackageExportName(mapped.sourcePack)

    this.serdePackagesUsed.add(mapped.sourcePack)
    this.updateUsedFixableSerde(mapped)

    return `${packExportName}.${ty}`
  }

  private mapStringSerde(ty: 'string') {
    const mapped = this.primaryTypeMap[ty]

    assertKnownSerdePackage(mapped.sourcePack)
    const packExportName = serdePackageExportName(mapped.sourcePack)

    this.serdePackagesUsed.add(mapped.sourcePack)
    this.updateUsedFixableSerde(mapped)

    return `${packExportName}.${mapped.beet}`
  }

  private mapOptionSerde(ty: IdlTypeOption, name: string) {
    const inner = this.mapSerde(ty.option, name)
    const optionPackage = BEET_PACKAGE

    this.serdePackagesUsed.add(optionPackage)
    this.usedFixableSerde = true

    const exp = serdePackageExportName(optionPackage)
    return `${exp}.coption(${inner})`
  }

  private mapVecSerde(ty: IdlTypeVec, name: string) {
    const inner = this.mapSerde(ty.vec, name)
    const arrayPackage = BEET_PACKAGE

    this.serdePackagesUsed.add(arrayPackage)
    this.usedFixableSerde = true

    const exp = serdePackageExportName(arrayPackage)
    return `${exp}.array(${inner})`
  }

  private mapArraySerde(ty: IdlTypeArray, name: string) {
    const inner = this.mapSerde(ty.array[0], name)
    const size = ty.array[1]
    const mapped = this.primaryTypeMap['UniformFixedSizeArray']
    const arrayPackage = mapped.sourcePack
    assertKnownSerdePackage(arrayPackage)

    this.serdePackagesUsed.add(arrayPackage)
    this.updateUsedFixableSerde(mapped)

    const exp = serdePackageExportName(arrayPackage)
    return `${exp}.${mapped.beet}(${inner}, ${size})`
  }

  private mapDefinedSerde(ty: IdlTypeDefined) {
    const fullFileDir = this.definedTypesImport(ty)
    const imports = getOrCreate(this.localImportsByPath, fullFileDir, new Set())
    const varName = beetVarNameFromTypeName(ty.defined)
    imports.add(varName)
    return varName
  }

  private mapEnumSerde(ty: IdlTypeEnum, name: string) {
    assert.notEqual(
      name,
      NO_NAME_PROVIDED,
      'Need to provide name for enum types'
    )
    const scalarEnumPackage = BEET_PACKAGE
    const exp = serdePackageExportName(BEET_PACKAGE)
    this.serdePackagesUsed.add(scalarEnumPackage)

    this.updateScalarEnumsUsed(name, ty)
    return `${exp}.fixedScalarEnum(${name})`
  }

  mapSerde(ty: IdlType, name: string = NO_NAME_PROVIDED): string {
    if (this.forceFixable(ty)) {
      this.usedFixableSerde = true
    }

    if (typeof ty === 'string') {
      return this.mapPrimitiveSerde(ty, name)
    }
    if (isIdlTypeOption(ty)) {
      return this.mapOptionSerde(ty, name)
    }
    if (isIdlTypeVec(ty)) {
      return this.mapVecSerde(ty, name)
    }
    if (isIdlTypeArray(ty)) {
      return this.mapArraySerde(ty, name)
    }
    if (isIdlTypeEnum(ty)) {
      return this.mapEnumSerde(ty, name)
    }
    if (isIdlTypeDefined(ty)) {
      const alias = this.typeAliases.get(ty.defined)
      return alias == null
        ? this.mapDefinedSerde(ty)
        : this.mapPrimitiveSerde(alias, name)
    }
    throw new Error(`Type ${ty} required for ${name} is not yet supported`)
  }

  mapSerdeField = (
    field: IdlField | IdlInstructionArg
  ): TypeMappedSerdeField => {
    const ty = this.mapSerde(field.type, field.name)
    return { name: field.name, type: ty }
  }

  mapSerdeFields(
    fields: (IdlField | IdlInstructionArg)[]
  ): TypeMappedSerdeField[] {
    return fields.map(this.mapSerdeField)
  }

  // -----------------
  // Imports Generator
  // -----------------
  importsUsed(fileDir: PathLike, forcePackages?: Set<SerdePackage>) {
    return [
      ...this._importsForSerdePackages(forcePackages),
      ...this._importsForLocalPackages(fileDir.toString()),
    ]
  }

  private _importsForSerdePackages(forcePackages?: Set<SerdePackage>) {
    const packagesToInclude =
      forcePackages == null
        ? this.serdePackagesUsed
        : new Set([
            ...Array.from(this.serdePackagesUsed),
            ...Array.from(forcePackages),
          ])
    const imports = []
    for (const pack of packagesToInclude) {
      const exp = serdePackageExportName(pack)
      imports.push(`import * as ${exp} from '${pack}';`)
    }
    return imports
  }

  private _importsForLocalPackages(fileDir: string) {
    const renderedImports: string[] = []
    for (const [originPath, imports] of this.localImportsByPath) {
      let relPath = path.relative(fileDir, originPath)
      if (!relPath.startsWith('.')) {
        relPath = `./${relPath}`
      }
      const importPath = withoutTsExtension(relPath)
      renderedImports.push(
        `import { ${Array.from(imports).join(', ')} }  from '${importPath}';`
      )
    }
    return renderedImports
  }

  assertBeetSupported(
    serde: IdlType,
    context: string
  ): asserts serde is BeetTypeMapKey | BeetSolanaTypeMapKey {
    assert(
      this.primaryTypeMap[serde as keyof PrimaryTypeMap] != null,
      `Types to ${context} need to be supported by Beet, ${serde} is not`
    )
  }
  private definedTypesImport(ty: IdlTypeDefined) {
    return (
      this.accountTypesPaths.get(ty.defined) ??
      this.customTypesPaths.get(ty.defined) ??
      assert.fail(
        `Unknown type ${ty.defined} is neither found in types nor an Account`
      )
    )
  }

  static defaultPrimaryTypeMap: PrimaryTypeMap = {
    ...beetSupportedTypeMap,
    ...beetSolanaSupportedTypeMap,
  }
}
